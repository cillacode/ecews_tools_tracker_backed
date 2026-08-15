// Centralised access-scoping for multi-state data isolation.
//
// Every "list" or "read" endpoint that touches facility-bound data calls one
// of these helpers so the rules live in ONE place. The rules:
//
//   super_admin              → sees everything (no scope)
//   admin / central_logistics → their state only
//   viewer with a state       → their state only
//   viewer with NULL state    → HQ viewer, sees everything
//   facility_user             → their own facility only
//   dso                       → facilities in their LGA only
//
// `req.user.effective_state_id` is populated by the auth middleware (the
// state derived from the user's own state_id, or via their facility/LGA).

const { badRequest } = require('../utils/errors');

// Appends a facility-level scope condition. `columnRef` is the SQL expression
// holding a facility id (e.g. 'm.facility_id', 'fs.facility_id', 'f.id').
// Mutates `conditions` + `params`. Returns true if a scope was applied
// (so the caller knows to ignore any user-supplied facility filter).
function applyFacilityScope(req, conditions, params, columnRef = 'facility_id') {
  const { role } = req.user;

  if (role === 'super_admin') return false;

  if (role === 'facility_user') {
    if (!req.user.facility_id) throw badRequest('Facility user has no facility assigned');
    params.push(req.user.facility_id);
    conditions.push(`${columnRef} = $${params.length}`);
    return true;
  }

  if (role === 'dso') {
    if (!req.user.lga_id) throw badRequest('DSO has no LGA assigned');
    params.push(req.user.lga_id);
    conditions.push(`${columnRef} IN (SELECT id FROM facilities WHERE lga_id = $${params.length})`);
    return true;
  }

  // admin / central_logistics / state-bound viewer
  if (req.user.effective_state_id) {
    params.push(req.user.effective_state_id);
    conditions.push(
      `${columnRef} IN (
         SELECT f.id FROM facilities f
         JOIN lgas l ON l.id = f.lga_id
         WHERE l.state_id = $${params.length})`
    );
    return true;
  }

  // HQ viewer (no state) → sees everything.
  return false;
}

// Scope a query that filters on a STATE id column directly (e.g. the
// facilities directory, which we scope to the user's state — never narrower —
// so within-state transfer pickers still work for facility users).
// `stateColumnRef` is the SQL expression holding a state id (e.g. 'l.state_id').
// Returns true if a scope was applied.
function applyStateScope(req, conditions, params, stateColumnRef = 'state_id') {
  const { role } = req.user;
  if (role === 'super_admin') return false;
  if (role === 'viewer' && !req.user.effective_state_id) return false; // HQ viewer

  if (!req.user.effective_state_id) {
    // Any non-super, non-HQ-viewer role MUST resolve to a state.
    throw badRequest('User has no state context');
  }
  params.push(req.user.effective_state_id);
  conditions.push(`${stateColumnRef} = $${params.length}`);
  return true;
}

// True when this user is restricted to a single LGA (dso) — used by endpoints
// that want to further narrow the directory for DSOs specifically.
function isLgaScoped(req) {
  return req.user.role === 'dso';
}

// Guard a single facility against the user's scope. Pass the facility's
// { id, lga_id, state_id }. Throws forbidden if out of scope. No-op for
// super_admin and HQ viewer.
function assertCanAccessFacility(req, forbidden, facility) {
  const { role } = req.user;
  if (role === 'super_admin') return;

  if (role === 'facility_user') {
    if (facility.id !== req.user.facility_id) {
      throw forbidden('You can only view your own facility');
    }
    return;
  }
  if (role === 'dso') {
    if (facility.lga_id !== req.user.lga_id) {
      throw forbidden('You can only view facilities in your LGA');
    }
    return;
  }
  // admin / central_logistics / state-bound viewer
  if (req.user.effective_state_id && facility.state_id !== req.user.effective_state_id) {
    throw forbidden('You can only view facilities in your state');
  }
}

module.exports = { applyFacilityScope, applyStateScope, isLgaScoped, assertCanAccessFacility };
