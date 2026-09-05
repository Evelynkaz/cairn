// Reserved client identities shared between the dashboard's own store calls
// and the MCP tool surface's client-name resolution.
//
// "Reserved" here means: the dashboard stamps every store call it makes
// itself with this id, so the §9 access log and connected-apps view can
// tell dashboard traffic apart from any other client. The dashboard's own
// PATCH /api/clients/:id route refuses to let this id be disabled, because
// the store's gate() refuses every gated call from a disabled client with
// no bypass -- if the dashboard could pause its own id, the very next
// request (including the one needed to re-enable it) would be refused,
// locking the user out of their own store with no recovery short of
// hand-editing SQLite. That guarantee only holds if no MCP client is ever
// allowed to occupy this id itself, since an impersonator would inherit
// both the un-pauseable guard and the attribution. sourceClientName() in
// ../mcp/tools.ts is what refuses the claim.
export const DASHBOARD_CLIENT = "cairn-dashboard";
