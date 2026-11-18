// =========================================================
// PathBinder — admin dashboard (lazy-loaded)
// Fetched on demand by _loadAdmin() in pb-app.js ONLY when an admin
// opens the Admin tab, so regular users never download or cache it.
// Classic script — shares global scope with pb-app.js, so it calls
// shared helpers (sb, currentUser, showToast, _escHtml, vendorApplications,
// renderAdminTable, renderAdminBetaTesters, updateRevenuePanel, …) directly.
// =========================================================

function _pbInjectAdminMarkup(){
  var el = document.getElementById('adminPage');
  if (!el || el.getAttribute('data-admin-injected')) return;
  el.setAttribute('data-admin-injected','1');
  el.innerHTML = `    <div class="admin-header">
      <h2>Admin</h2>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn-outline" id="refreshPricesBtn" onclick="triggerPriceRefresh()" style="font-size:.8rem;padding:6px 12px">Refresh Prices</button>
      </div>
    </div>
    <div id="priceRefreshStatus" style="display:none;font-size:.82rem;padding:10px 14px;border:1px solid var(--border);background:var(--surface2);margin-bottom:16px"></div>
<style>
    #adminPage .admin-tabs{display:flex;gap:4px;flex-wrap:wrap;margin:14px 0 20px;border-bottom:1px solid var(--border);padding-bottom:10px}
    #adminPage .admin-tab{font-family:'Space Mono',monospace;font-size:.7rem;letter-spacing:.06em;padding:7px 14px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;border-radius:6px;transition:all .15s;white-space:nowrap}
    #adminPage .admin-tab:hover{border-color:var(--accent);color:var(--accent)}
    #adminPage .admin-tab.active{border-color:var(--accent);background:var(--accent);color:var(--text-on-accent,#031);font-weight:700}
    #adminPage .admin-panel{display:none}
    #adminPage .admin-panel.active{display:block}
    #adminPage .admin-ov-h{font-family:'Orbitron',monospace;font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--copper);margin:18px 0 10px}
    #adminPage .admin-ov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:10px;margin-bottom:8px}
    #adminPage .admin-ov-tile{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px 15px}
    #adminPage .admin-ov-val{font-family:'Orbitron',monospace;font-size:1.35rem;font-weight:800;color:var(--text);line-height:1.1}
    #adminPage .admin-ov-lbl{font-size:.6rem;letter-spacing:.08em;color:var(--muted);margin-top:6px;text-transform:uppercase}
    #adminPage .admin-ov-sub{font-size:.56rem;color:var(--muted);margin-top:3px;font-style:italic}
    </style>
<div class="admin-tabs">
      <button class="admin-tab active" data-tab="adminOverview"   onclick="switchAdminTab('adminOverview')">Overview</button>
      <button class="admin-tab"        data-tab="adminModeration" onclick="switchAdminTab('adminModeration')">Moderation</button>
      <button class="admin-tab"        data-tab="adminBeta"       onclick="switchAdminTab('adminBeta')">Beta &amp; Vendors</button>
      <button class="admin-tab"        data-tab="adminCardData"   onclick="switchAdminTab('adminCardData')">Card Data</button>
      <button class="admin-tab"        data-tab="adminGiveaways"  onclick="switchAdminTab('adminGiveaways')">Giveaways</button>
      <button class="admin-tab"        data-tab="adminSystem"     onclick="switchAdminTab('adminSystem')">System</button>
    </div>
<div class="admin-panel active" id="adminOverview">
      <div class="admin-ov-h">Platform Revenue (est.)</div>
      <div class="admin-ov-grid" id="ovRevenue"><div class="admin-ov-tile"><div class="admin-ov-val">…</div><div class="admin-ov-lbl">Loading</div></div></div>
      <div class="admin-ov-h">Users &amp; Subscriptions</div>
      <div class="admin-ov-grid" id="ovUsers"></div>
      <div class="admin-ov-h">Content</div>
      <div class="admin-ov-grid" id="ovContent"></div>
      <div class="admin-ov-h">Moderation Queues</div>
      <div class="admin-ov-grid" id="ovModeration"></div>
    </div>
<div class="admin-panel" id="adminModeration">
    <!-- DISPUTES PANEL — admin reviews orders escalated to 'disputed'
         status (seller declined a buyer's return). Two actions per
         dispute: refund the buyer (calls /api/refund-order) or resolve
         in the seller's favor (admin_resolve_dispute_for_seller RPC,
         no money moves). Auto-loads when admin opens the page; deep-link
         ?admin=disputes&order=<id> scrolls + highlights a specific row. -->
    <div id="adminDisputesPanel" style="background:var(--surface);border:1.5px solid var(--red);border-radius:14px;padding:18px;margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div style="font-size:.75rem;color:var(--red);letter-spacing:.08em">Open Disputes <span id="adminDisputesCount" style="color:var(--muted)"></span></div>
        <div style="display:flex;gap:6px">
          <button type="button" onclick="sendAdminTestEmail()" title="Triggers the admin-notify-dispute endpoint for the most recent disputed order to verify Resend wiring" style="background:transparent;border:1px solid var(--copper);color:var(--copper);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.7rem;padding:5px 12px;cursor:pointer">Send test email</button>
          <button type="button" onclick="loadAdminDisputes()" style="background:transparent;border:1px solid var(--border);color:var(--muted);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.7rem;padding:5px 12px;cursor:pointer">Refresh</button>
        </div>
      </div>
      <div id="adminDisputesList"><div style="color:var(--muted);font-size:.8rem">Loading…</div></div>
    </div>

    <!-- CONTENT REPORTS PANEL — user-filed abuse flags on listings, profiles,
         reviews, photos (content_reports). Satisfies App Store Guideline 1.2 /
         Play UGC. Admin marks each actioned or dismissed. -->
    <div id="adminContentReportsPanel" style="background:var(--surface);border:1.5px solid var(--copper);border-radius:14px;padding:18px;margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div style="font-size:.75rem;color:var(--copper);letter-spacing:.08em">Content Reports <span id="adminContentReportsCount" style="color:var(--muted)"></span></div>
        <button type="button" onclick="loadContentReports()" style="background:transparent;border:1px solid var(--border);color:var(--muted);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.7rem;padding:5px 12px;cursor:pointer">Refresh</button>
      </div>
      <div id="adminContentReportsList"><div style="color:var(--muted);font-size:.8rem">Loading…</div></div>
    </div>

    <!-- USER MANAGEMENT PANEL — search by email/username, view summary,
         ban / unban. Ban flips profiles.is_banned + cascades all active
         listings to suspended. Sign-in is blocked server-side via
         is_account_banned() so even an open session terminates on next
         page load. -->
    <div style="background:var(--surface);border:1.5px solid var(--copper-dim);border-radius:14px;padding:18px;margin-bottom:24px">
      <div style="font-size:.75rem;color:var(--copper);letter-spacing:.08em;margin-bottom:14px">User Management</div>
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <input type="text" id="adminUserSearch" placeholder="Search by email or username" style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.85rem"
          onkeydown="if(event.key==='Enter')searchAdminUsers()" />
        <button type="button" onclick="searchAdminUsers()" style="padding:8px 18px;background:var(--accent);color:var(--text-on-accent);border:none;font-family:'Space Mono','Share Tech Mono',monospace;font-size:.78rem;font-weight:700;cursor:pointer">Search</button>
      </div>
      <div id="adminUserResults" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>

    <!-- SUSPENDED LISTINGS PANEL — quick overview of everything admin
         has pulled, with the seller-supplied reason and a one-click
         Restore action. Helps avoid forgetting about suspensions. -->
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div style="font-size:.75rem;color:var(--yellow);letter-spacing:.08em">Suspended Listings</div>
        <button type="button" onclick="loadSuspendedListings()" style="background:transparent;border:1px solid var(--border);color:var(--muted);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.7rem;padding:5px 12px;cursor:pointer">Refresh</button>
      </div>
      <div id="adminSuspendedList"><div style="color:var(--muted);font-size:.8rem">Loading…</div></div>
    </div>

    <!-- Order Refund Tool -->
    <div style="margin-top:24px;border:1px solid var(--border);background:var(--surface);padding:16px 18px">
      <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--copper);margin-bottom:8px;text-transform:uppercase">Order Refund</div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Refund a marketplace order via the Stripe refund API. Refunds the buyer, marks the order refunded, and restores the listing to available. Use within the 7-day buyer protection window or when resolving disputes.
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="text" id="adminRefundOrderId" placeholder="Order ID (full uuid)"
          style="flex:1;min-width:240px;background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.62rem;color:var(--text);outline:none"
          onkeydown="if(event.key==='Enter')adminRefundOrder()">
        <select id="adminRefundReason"
          style="background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.6rem;color:var(--text);outline:none">
          <option value="requested_by_customer">Requested by customer</option>
          <option value="fraudulent">Fraudulent</option>
          <option value="duplicate">Duplicate</option>
        </select>
        <button onclick="adminRefundOrder()"
          style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:6px 14px;border:1px solid var(--copper);background:transparent;color:var(--copper);cursor:pointer;white-space:nowrap">
          Refund via Stripe
        </button>
      </div>
      <div id="adminRefundStatus" style="margin-top:8px;font-family:'Space Mono',monospace;font-size:.6rem;color:var(--muted);min-height:16px;line-height:1.6"></div>
    </div>

    </div>
<div class="admin-panel" id="adminBeta">
    <!-- Vendor Applications Panel (admin only) -->
    <div style="background:var(--surface);border:1.5px solid var(--accent);border-radius:14px;padding:18px;margin-bottom:24px">
      <div style="font-size:.75rem;color:var(--accent);letter-spacing:.08em;margin-bottom:14px">Vendor Applications</div>
      <div id="vendorApplicationsPanel"><div style="color:var(--muted);font-size:.8rem">Loading...</div></div>
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;overflow-x:auto">
    <!-- Beta Tester Manager — invite-only access for pre-launch testers -->
    <div style="margin-top:24px;border:1px solid var(--border);background:var(--surface);padding:16px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--copper);text-transform:uppercase">Beta Testers</div>
        <button onclick="showToast('Beta schema lives in SQL Migrations/migration_beta_founding_shop_and_cleanup.sql — run that in Supabase.')"
          style="font-family:'Space Mono',monospace;font-size:.55rem;letter-spacing:.06em;padding:4px 10px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer" title="The old Print SQL generator was stale and would revert the current schema — the migration file is the source of truth.">Beta SQL</button>
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Invite-only access for pre-launch testers. Email-grant applies the tier immediately if the email matches a user, or waits for them to sign up. Codes can be redeemed from the user dropdown. Email changes on beta accounts are logged automatically.
      </div>

      <!-- Founding Beta (vendor tier × 25) -->
      <div id="betaSectionFounding" style="margin-bottom:14px;border:1px solid rgba(184,115,51,.35);background:rgba(184,115,51,.04)">
        <div onclick="adminToggleBetaSection('founding')"
          style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;user-select:none">
          <div style="display:flex;align-items:center;gap:10px">
            <span id="betaCaretFounding" style="font-family:'Space Mono',monospace;font-size:.7rem;color:var(--copper);transition:transform .15s">▾</span>
            <span style="font-family:'Orbitron',monospace;font-size:.65rem;font-weight:700;letter-spacing:.1em;color:var(--copper);text-transform:uppercase">Founding Beta — Vendor</span>
            <span id="betaCountFounding" style="font-family:'Space Mono',monospace;font-size:.6rem;color:var(--muted)">0 / 25</span>
          </div>
          <span style="font-family:'Space Mono',monospace;font-size:.55rem;color:var(--muted);letter-spacing:.06em">Permanent vendor access · no subscription required</span>
        </div>
        <div id="betaBodyFounding" style="padding:0 14px 14px 14px">
          <div id="betaListFounding" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">
            <div style="font-size:.6rem;color:rgba(184,115,51,.5);letter-spacing:.06em">Loading…</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding-top:10px;border-top:1px solid rgba(184,115,51,.2)">
            <input type="text" id="betaInviteEmailFounding" placeholder="email@example.com"
              style="flex:1;min-width:170px;background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.6rem;color:var(--text);outline:none">
            <button onclick="adminInviteBetaTester('founding','email')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--copper);background:transparent;color:var(--copper);cursor:pointer;white-space:nowrap">Invite by Email</button>
            <button onclick="adminInviteBetaTester('founding','code')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer;white-space:nowrap">Generate Code</button>
          </div>
        </div>
      </div>

      <!-- Enthusiast Beta (enthusiast tier × 20) -->
      <div id="betaSectionEnthusiast" style="margin-bottom:10px;border:1px solid rgba(26,199,160,.4);background:rgba(26,199,160,.05)">
        <div onclick="adminToggleBetaSection('enthusiast')"
          style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;user-select:none">
          <div style="display:flex;align-items:center;gap:10px">
            <span id="betaCaretEnthusiast" style="font-family:'Space Mono',monospace;font-size:.7rem;color:var(--accent);transition:transform .15s">▾</span>
            <span style="font-family:'Orbitron',monospace;font-size:.65rem;font-weight:700;letter-spacing:.1em;color:var(--accent);text-transform:uppercase">Enthusiast Beta</span>
            <span id="betaCountEnthusiast" style="font-family:'Space Mono',monospace;font-size:.6rem;color:var(--muted)">0 / 20</span>
          </div>
          <span style="font-family:'Space Mono',monospace;font-size:.55rem;color:var(--muted);letter-spacing:.06em">1-year free · marketplace selling · 40 cap · then converts to Free</span>
        </div>
        <div id="betaBodyEnthusiast" style="padding:0 14px 14px 14px">
          <div id="betaListEnthusiast" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">
            <div style="font-size:.6rem;color:rgba(26,199,160,.4);letter-spacing:.06em">Loading…</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding-top:10px;border-top:1px solid rgba(26,199,160,.15)">
            <input type="text" id="betaInviteEmailEnthusiast" placeholder="email@example.com"
              style="flex:1;min-width:170px;background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.6rem;color:var(--text);outline:none">
            <button onclick="adminInviteBetaTester('enthusiast','email')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--copper);background:transparent;color:var(--copper);cursor:pointer;white-space:nowrap">Invite by Email</button>
            <button onclick="adminInviteBetaTester('enthusiast','code')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer;white-space:nowrap">Generate Code</button>
          </div>
        </div>
      </div>

      <!-- Vendor Beta (vendor tier × 5) -->
      <div id="betaSectionVendor" style="margin-bottom:10px;border:1px solid rgba(184,115,51,.45);background:rgba(184,115,51,.05)">
        <div onclick="adminToggleBetaSection('vendor')"
          style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;user-select:none">
          <div style="display:flex;align-items:center;gap:10px">
            <span id="betaCaretVendor" style="font-family:'Space Mono',monospace;font-size:.7rem;color:var(--copper);transition:transform .15s">▾</span>
            <span style="font-family:'Orbitron',monospace;font-size:.65rem;font-weight:700;letter-spacing:.1em;color:var(--copper);text-transform:uppercase">Vendor Beta</span>
            <span id="betaCountVendor" style="font-family:'Space Mono',monospace;font-size:.6rem;color:var(--muted)">0 / 5</span>
          </div>
          <span style="font-family:'Space Mono',monospace;font-size:.55rem;color:var(--muted);letter-spacing:.06em">1-year free · sealed + non-TCG · 150 cap · then converts to Free</span>
        </div>
        <div id="betaBodyVendor" style="padding:0 14px 14px 14px">
          <div id="betaListVendor" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">
            <div style="font-size:.6rem;color:rgba(184,115,51,.5);letter-spacing:.06em">Loading…</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding-top:10px;border-top:1px solid rgba(184,115,51,.2)">
            <input type="text" id="betaInviteEmailVendor" placeholder="email@example.com"
              style="flex:1;min-width:170px;background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.6rem;color:var(--text);outline:none">
            <button onclick="adminInviteBetaTester('vendor','email')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--copper);background:transparent;color:var(--copper);cursor:pointer;white-space:nowrap">Invite by Email</button>
            <button onclick="adminInviteBetaTester('vendor','code')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer;white-space:nowrap">Generate Code</button>
          </div>
        </div>
      </div>

      <!-- Founding Shop (shop tier × 1) — the single permanent flagship partner.
           Grants permanent Shop tier. Inviting by email before the shop signs
           up stays permanent (the auto-claim trigger honors founding_shop).
           To switch the flagship to a different shop: Revoke the current one
           (drops them to Free + frees the slot), then invite the new shop. -->
      <div id="betaSectionFoundingShop" style="border:1px solid rgba(255,233,74,.4);background:rgba(255,233,74,.05)">
        <div onclick="adminToggleBetaSection('founding_shop')"
          style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;user-select:none">
          <div style="display:flex;align-items:center;gap:10px">
            <span id="betaCaretFoundingShop" style="font-family:'Space Mono',monospace;font-size:.7rem;color:var(--gold,#FFE94A);transition:transform .15s">▾</span>
            <span style="font-family:'Orbitron',monospace;font-size:.65rem;font-weight:700;letter-spacing:.1em;color:var(--gold,#FFE94A);text-transform:uppercase">Founding Shop — Shop</span>
            <span id="betaCountFoundingShop" style="font-family:'Space Mono',monospace;font-size:.6rem;color:var(--muted)">0 / 1</span>
          </div>
          <span style="font-family:'Space Mono',monospace;font-size:.55rem;color:var(--muted);letter-spacing:.06em">Single permanent Shop partner · no subscription required</span>
        </div>
        <div id="betaBodyFoundingShop" style="padding:0 14px 14px 14px">
          <div id="betaListFoundingShop" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">
            <div style="font-size:.6rem;color:rgba(255,233,74,.5);letter-spacing:.06em">Loading…</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding-top:10px;border-top:1px solid rgba(255,233,74,.2)">
            <input type="text" id="betaInviteEmailFoundingShop" placeholder="email@example.com"
              style="flex:1;min-width:170px;background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.6rem;color:var(--text);outline:none">
            <button onclick="adminInviteBetaTester('founding_shop','email')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--copper);background:transparent;color:var(--copper);cursor:pointer;white-space:nowrap">Invite by Email</button>
            <button onclick="adminInviteBetaTester('founding_shop','code')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--gold,#FFE94A);background:transparent;color:var(--gold,#FFE94A);cursor:pointer;white-space:nowrap">Generate Code</button>
          </div>
        </div>
      </div>

      <!-- Shop Beta (shop tier × 3) — 1-year free membership, then converts to Free -->
      <div id="betaSectionShop" style="border:1px solid rgba(255,233,74,.3);background:rgba(255,233,74,.03);margin-top:10px">
        <div onclick="adminToggleBetaSection('shop')"
          style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;user-select:none">
          <div style="display:flex;align-items:center;gap:10px">
            <span id="betaCaretShop" style="font-family:'Space Mono',monospace;font-size:.7rem;color:var(--gold,#FFE94A);transition:transform .15s">▾</span>
            <span style="font-family:'Orbitron',monospace;font-size:.65rem;font-weight:700;letter-spacing:.1em;color:var(--gold,#FFE94A);text-transform:uppercase">Shop Beta</span>
            <span id="betaCountShop" style="font-family:'Space Mono',monospace;font-size:.6rem;color:var(--muted)">0 / 3</span>
          </div>
          <span style="font-family:'Space Mono',monospace;font-size:.55rem;color:var(--muted);letter-spacing:.06em">Shop-tier access · 1-year free · then converts to Free</span>
        </div>
        <div id="betaBodyShop" style="padding:0 14px 14px 14px">
          <div id="betaListShop" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">
            <div style="font-size:.6rem;color:rgba(255,233,74,.5);letter-spacing:.06em">Loading…</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding-top:10px;border-top:1px solid rgba(255,233,74,.2)">
            <input type="text" id="betaInviteEmailShop" placeholder="email@example.com"
              style="flex:1;min-width:170px;background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.6rem;color:var(--text);outline:none">
            <button onclick="adminInviteBetaTester('shop','email')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--copper);background:transparent;color:var(--copper);cursor:pointer;white-space:nowrap">Invite by Email</button>
            <button onclick="adminInviteBetaTester('shop','code')"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid var(--gold,#FFE94A);background:transparent;color:var(--gold,#FFE94A);cursor:pointer;white-space:nowrap">Generate Code</button>
            <button onclick="adminSweepExpiredShopBeta()" title="Downgrades any beta whose 1-year window has lapsed → Free"
              style="font-family:'Space Mono',monospace;font-size:.58rem;letter-spacing:.06em;padding:6px 12px;border:1px solid rgba(255,100,100,.5);background:transparent;color:rgba(255,100,100,.85);cursor:pointer;white-space:nowrap">Sweep Expired</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Subsidiary invite tracker (read-only). Lists friend-of-tester codes. -->
    <div style="margin-top:18px;border-top:1px solid var(--border);padding-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-family:'Orbitron',monospace;font-size:.7rem;letter-spacing:.1em;color:var(--accent);text-transform:uppercase">Subsidiary Invites</div>
        <button type="button" onclick="renderAdminSubsidiaryInvites()" style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:5px 12px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer">Refresh</button>
      </div>
      <div id="adminSubsidiaryInvitesList"><div style="color:var(--muted);font-size:.8rem">Loading…</div></div>
    </div>

    </div>
    </div>
<div class="admin-panel" id="adminCardData">
    <!-- Card Editor — admin-curated overrides driven by user error reports -->
    <div style="margin-top:24px;border:1px solid var(--border);background:var(--surface);padding:16px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--copper);text-transform:uppercase">Card Editor</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button onclick="adminLoadCardReports('open')" id="adminCRTabOpen"
            style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:5px 12px;border:1px solid var(--copper);background:rgba(184,115,51,.12);color:var(--copper);cursor:pointer">Open Reports</button>
          <button onclick="adminLoadCardReports('resolved')" id="adminCRTabResolved"
            style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:5px 12px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer">Resolved</button>
          <button onclick="adminOpenCardOverrideEditor(null)"
            style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:5px 12px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer">+ Manual Override</button>
        </div>
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Review user-submitted reports about wrong card data and curate global overrides. Saved corrections apply to every new card add via search/scan.
      </div>
      <div id="adminCardReportsList" style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:.62rem;color:rgba(26,199,160,.4);letter-spacing:.08em">Click "Open Reports" to load.</div>
      </div>
    </div>

    <!-- Price Mismatch Audit — finds cards whose PriceCharting
         (catalog.current_value) and TCGplayer (card_prices) prices diverge
         wildly, which almost always means a mis-linked PriceCharting product.
         "Clear PC" nulls the bad PC id/url/value so the suggested price falls
         back to TCGplayer and the next enrichment re-matches it. -->
    <div style="margin-top:24px;border:1px solid var(--border);background:var(--surface);padding:16px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--copper);text-transform:uppercase">Price Mismatch Audit</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <label style="font-family:'Space Mono',monospace;font-size:.58rem;color:var(--muted)">Min ratio</label>
          <input id="adminPmThreshold" type="number" inputmode="decimal" value="4" min="2" style="width:54px;text-align:center;padding:4px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'Space Mono',monospace;font-size:.62rem">
          <button onclick="renderAdminPriceMismatch()" style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:5px 12px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer">Scan</button>
        </div>
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Cards where PriceCharting and TCGplayer disagree by ≥ the ratio — usually a mis-linked PriceCharting product (TCGplayer is ID-matched, so it's the reliable side). Check both ↗ links to confirm which is wrong, then "Clear PC" to drop the bad PriceCharting value; the suggested price falls back to TCGplayer until the next enrichment re-links it.
      </div>
      <div id="adminPriceMismatchList" style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:.62rem;color:rgba(26,199,160,.4);letter-spacing:.08em">Click "Scan" to find divergent prices.</div>
      </div>
    </div>

    <!-- Catalog Image Contribution Queue — pending submissions from
         users whose scan picked up a card with no catalog photo.
         Approve to write to catalog.image_url and credit the user;
         reject with a reason to add a strike. -->
    <div style="margin-top:24px;border:1px solid var(--accent);background:rgba(26,199,160,.04);padding:16px 18px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--accent);text-transform:uppercase">Catalog Image Contributions</div>
        <button onclick="renderAdminContributionQueue()" class="pb-panel-link" style="border-color:var(--accent);color:var(--accent);font-size:.62rem">Refresh</button>
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:14px;line-height:1.6">
        Photos submitted by eligible Collector+ users when their scan hits a catalog row with no image. Approve to land the photo on the catalog and credit the contributor; reject with a reason to apply a strike. <code>migration_catalog_image_contributions.sql</code> + <code>catalog-contributions</code> storage bucket required.
      </div>
      <div id="adminContributionQueue" style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:.6rem;color:var(--muted)">Click Refresh to load.</div>
      </div>
    </div>

    <!-- Image Review Queue — listings flagged via the FLAG IMG button
         on each marketplace card. Sorted oldest-flag-first so the
         backlog clears in order. -->
    <div style="margin-top:24px;border:1px solid var(--copper-dim);background:rgba(184,115,51,.04);padding:16px 18px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--copper);text-transform:uppercase">Image Review Queue</div>
        <button onclick="renderAdminImageReviewQueue()" class="pb-panel-link" style="border-color:var(--copper-dim);color:var(--copper);font-size:.62rem">Refresh</button>
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:14px;line-height:1.6">
        Listings whose photos need to be replaced (poor quality, wrong product, watermark, etc.). Flag a listing from the marketplace browse via the small <span style="color:var(--copper)">FLAG IMG</span> button on each card. Apply <code>migration_listings_image_review.sql</code> first.
      </div>
      <div id="adminImageReviewQueue" style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:.6rem;color:var(--muted)">Click Refresh to load.</div>
      </div>
    </div>

    <!-- Sealed BG Review Queue — flagged products whose automated bg
         removal couldn't strip the background (cream / yellow / photo
         backgrounds). Admins replace the image with a hand-cleaned
         version, which clears the needs_manual_bg flag. -->
    <div style="margin-top:24px;border:1px solid var(--border);background:var(--surface);padding:16px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--copper);text-transform:uppercase">Sealed BG Review</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button onclick="adminLoadBgReviewQueue()" id="adminBgReviewLoadBtn"
            style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:5px 12px;border:1px solid var(--copper);background:rgba(184,115,51,.12);color:var(--copper);cursor:pointer">Load Queue</button>
          <span id="adminBgReviewCount" style="font-family:'Space Mono',monospace;font-size:.6rem;color:var(--muted);align-self:center"></span>
        </div>
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Products auto-flagged by restore_sealed_bg.py when bg removal couldn't strip the background (cream / yellow / gradient / photo bg). Upload a hand-cleaned PNG/WebP to replace the image — clears the flag.
      </div>
      <div id="adminBgReviewList" style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:.62rem;color:rgba(184,115,51,.5);letter-spacing:.08em">Click "Load Queue" to fetch flagged products.</div>
      </div>
    </div>

    <!-- Image Backfill Tool -->
    <div style="margin-top:24px;border:1px solid var(--border);background:var(--surface);padding:16px 18px">
      <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--accent);margin-bottom:8px;text-transform:uppercase">Image Backfill</div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Repair missing card images for any user. Finds cards with <code>api_card_id</code> but no <code>card_image_url</code> and fills them from the catalog.
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="text" id="adminBackfillUsername" placeholder="username or display name…"
          style="flex:1;min-width:180px;background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.62rem;color:var(--text);outline:none"
          onkeydown="if(event.key==='Enter')adminBackfillUserImages()">
        <button onclick="adminBackfillUserImages()"
          style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:6px 14px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer;white-space:nowrap">
          Run Backfill
        </button>
      </div>
      <div id="adminBackfillStatus" style="margin-top:8px;font-family:'Space Mono',monospace;font-size:.6rem;color:var(--muted);min-height:16px;line-height:1.6"></div>
    </div>

    </div>
<div class="admin-panel" id="adminSystem">
    <!-- Shop Tier Metrics -->
    <div style="margin-top:24px;border:1px solid var(--border);background:var(--surface);padding:16px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--accent);text-transform:uppercase">Shop Tier Metrics</div>
        <button onclick="adminLoadShopMetrics()"
          style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:6px 14px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer">Refresh</button>
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Platform GMV + per-shop breakdown. Reads from <code>shop_tier_platform_metrics</code> and <code>shop_seller_metrics</code> views. Apply <code>migration_shop_seller_metrics.sql</code> first.
      </div>
      <div id="adminShopMetricsPanel" style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted)">Click Refresh to load.</div>
    </div>

    <!-- Sealed Products Migration + Sync -->
    <div style="margin-top:24px;border:1px solid var(--border);background:var(--surface);padding:16px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--accent);text-transform:uppercase">Sealed Products</div>
        <button onclick="printSealedProductsMigration();showToast('Sealed products migration printed to console')"
          style="font-family:'Space Mono',monospace;font-size:.55rem;letter-spacing:.06em;padding:4px 10px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer">Print SQL</button>
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Adds <code>product_type</code> + sealed metadata to <code>catalog</code> and <code>listings</code>. Idempotent &mdash; safe to re-run. After the migration applies, run
        <code>python pokedata_sync.py --tcg pokemon-en --product-type sealed</code> to populate the catalog with ETBs, UTBs, booster boxes, etc. from PriceCharting.
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.58rem;color:var(--copper);line-height:1.5">
        Verify: <code>select count(*) from catalog where product_type &lt;&gt; 'single';</code>
      </div>
    </div>

    <!-- Danger Zone -->
    <div style="margin-top:24px;border:1px solid rgba(255,60,60,.35);background:rgba(255,60,60,.04);padding:16px 18px">
      <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:rgba(255,100,100,.85);margin-bottom:14px;text-transform:uppercase">Danger Zone</div>
      <div style="font-family:'Space Mono','Share Tech Mono',monospace;font-size:.62rem;color:var(--muted);margin-bottom:14px;line-height:1.6">
        Permanently delete all collection cards for a user. Binders are kept. This cannot be undone.
      </div>
      <div id="adminClearCollectionUsers" style="display:flex;flex-direction:column;gap:8px">
        <div style="font-size:.6rem;color:rgba(26,199,160,.4);letter-spacing:.08em">Loading users…</div>
      </div>
    </div>
    </div>
<div class="admin-panel" id="adminGiveaways">
    <div style="margin-top:4px;border:1px solid var(--border);background:var(--surface);padding:16px 18px;margin-bottom:20px">
      <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--copper);text-transform:uppercase;margin-bottom:12px">Create Giveaway</div>
      <div style="display:flex;flex-direction:column;gap:10px;max-width:540px">
        <label style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;color:var(--muted);display:flex;flex-direction:column;gap:4px">INTERNAL NAME &mdash; admin only, not shown to users
          <input type="text" id="gaName" placeholder="e.g. Nov 2026 Team Rocket Briefcase"
            style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);padding:8px 12px;font-family:'Space Mono',monospace;font-size:.78rem;color:var(--text);outline:none"></label>
        <label style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;color:var(--muted);display:flex;flex-direction:column;gap:4px">PRIZE SHOWN TO USERS &mdash; banner &amp; giveaway-page headline
          <input type="text" id="gaPrize" placeholder="e.g. Sealed Team Rocket Briefcase + booster box"
            style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);padding:8px 12px;font-family:'Space Mono',monospace;font-size:.78rem;color:var(--text);outline:none"></label>
        <label style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;color:var(--muted);display:flex;flex-direction:column;gap:4px">GRAND PRIZE &mdash; rank 1, in the winner email
          <input type="text" id="gaPrizeGrand" placeholder="defaults to the prize above if left blank"
            style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);padding:8px 12px;font-family:'Space Mono',monospace;font-size:.72rem;color:var(--text);outline:none"></label>
        <label style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;color:var(--muted);display:flex;flex-direction:column;gap:4px">OTHER WINNERS &mdash; ranks 2+, in the winner email
          <input type="text" id="gaPrizeRest" placeholder="e.g. a card pulled from the second box, revealed in our video"
            style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);padding:8px 12px;font-family:'Space Mono',monospace;font-size:.72rem;color:var(--text);outline:none"></label>
        <label style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;color:var(--muted);display:flex;flex-direction:column;gap:4px">PHOTO (optional) &mdash; shown on the giveaway page
          <input type="file" id="gaImage" accept="image/*"
            style="font-family:'Space Mono',monospace;font-size:.68rem;color:var(--muted);background:var(--surface2);border:1px solid var(--border);padding:7px 10px"></label>
        <label style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;color:var(--muted);display:flex;flex-direction:column;gap:4px">VIDEO (optional) &mdash; e.g. the pack-opening / pull clip (max 100 MB)
          <input type="file" id="gaVideo" accept="video/*"
            style="font-family:'Space Mono',monospace;font-size:.68rem;color:var(--muted);background:var(--surface2);border:1px solid var(--border);padding:7px 10px"></label>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
          <label style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;color:var(--muted);display:flex;flex-direction:column;gap:4px">WINNERS / PRIZES
            <input type="number" id="gaWinners" value="1" min="1" step="1" inputmode="numeric"
              style="width:80px;background:var(--surface2);border:1px solid var(--border);padding:7px 10px;font-family:'Space Mono',monospace;font-size:.78rem;color:var(--text);outline:none"></label>
          <label style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;color:var(--muted);display:flex;flex-direction:column;gap:4px">STARTS (optional)
            <input type="datetime-local" id="gaOpens"
              style="background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.74rem;color:var(--text);outline:none"></label>
          <label style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;color:var(--muted);display:flex;flex-direction:column;gap:4px">CLOSES (optional)
            <input type="datetime-local" id="gaCloses"
              style="background:var(--surface2);border:1px solid var(--border);padding:6px 10px;font-family:'Space Mono',monospace;font-size:.74rem;color:var(--text);outline:none"></label>
        </div>
        <button type="button" onclick="adminCreateGiveaway()"
          style="align-self:flex-start;background:var(--accent);color:var(--text-on-accent);border:none;padding:9px 20px;font-family:'Space Mono',monospace;font-size:.72rem;font-weight:700;letter-spacing:.06em;cursor:pointer">Create as draft</button>
      </div>
      <div style="font-family:'Space Mono',monospace;font-size:.58rem;color:var(--muted);margin-top:12px;line-height:1.6">
        New giveaways start as <strong style="color:var(--text)">draft</strong> (hidden from users). <strong style="color:var(--text)">Announce</strong> shows a public &ldquo;starting soon&rdquo; countdown to STARTS (no entries yet). <strong style="color:var(--text)">Open</strong> makes it live and auto-enters paying subscribers. <strong style="color:var(--text)">WINNERS / PRIZES</strong> is how many prizes you&rsquo;re giving away &mdash; the live-draw spinner spins <strong style="color:var(--text)">once per prize</strong>, and each winner is emailed their own prize. Entry totals are visible to admins only &mdash; each user sees only their own entry count.
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <div style="font-family:'Orbitron',monospace;font-size:.72rem;font-weight:800;letter-spacing:.1em;color:var(--accent);text-transform:uppercase">Giveaways</div>
      <button type="button" onclick="renderAdminGiveaways()"
        style="font-family:'Space Mono',monospace;font-size:.6rem;letter-spacing:.06em;padding:6px 14px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer">Refresh</button>
    </div>
    <div id="adminGiveawaysList"><div style="color:var(--muted);font-size:.8rem">Loading…</div></div>
    </div>`;
}

    async function loadVendorApplications() {
      if (!currentUser?.is_admin) return;
      // Fetch applications first (no join — avoids 400 if FK not in schema cache)
      const { data: apps } = await sb.from('vendor_applications').select('*').order('submitted_at', { ascending: false });
      if (!apps || !apps.length) { vendorApplications = []; return; }
      // Then fetch matching profiles separately and merge in
      const userIds = [...new Set(apps.map(a => a.user_id).filter(Boolean))];
      let profileMap = {};
      if (userIds.length) {
        const { data: profs } = await sb.from('profiles').select('id, email, username').in('id', userIds);
        if (profs) profs.forEach(p => { profileMap[p.id] = p; });
      }
      vendorApplications = apps.map(a => ({ ...a, profiles: profileMap[a.user_id] || null }));
    }

    async function approveVendorApplication(userId, appId) {
      await sb.from('profiles').update({ is_vendor: true }).eq('id', userId);
      await sb.from('vendor_applications').update({ status: 'approved', reviewed_at: new Date().toISOString() }).eq('id', appId);
      vendorApplications = vendorApplications.map(a => a.id === appId ? { ...a, status: 'approved' } : a);
      renderAdminVendorApplications();
      showToast('Vendor approved ');
    }

    async function rejectVendorApplication(appId) {
      const notes = prompt('Optional: reason for rejection (shown to admin only)');
      await sb.from('vendor_applications').update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewer_notes: notes || null }).eq('id', appId);
      vendorApplications = vendorApplications.map(a => a.id === appId ? { ...a, status: 'rejected' } : a);
      renderAdminVendorApplications();
      showToast('Application rejected');
    }

    function renderAdminVendorApplications() {
      const el = document.getElementById('vendorApplicationsPanel');
      if (!el) return;
      if (!vendorApplications.length) { el.innerHTML = '<div style="color:var(--muted);font-size:.8rem;padding:12px 0">No applications yet.</div>'; return; }
      el.innerHTML = vendorApplications.map(a => {
        const statusColor = { pending: 'var(--accent)', approved: 'var(--green)', rejected: 'var(--red)' }[a.status] || 'var(--muted)';
        return `<div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div>
              <div style="font-size:.9rem;color:var(--text);font-weight:700">${a.shop_name}</div>
              <div style="font-size:.72rem;color:var(--muted);margin-top:2px">${a.profiles?.email || a.user_id} · ${new Date(a.submitted_at).toLocaleDateString()}</div>
              ${a.shop_location ? `<div style="font-size:.72rem;color:var(--muted)">${a.shop_location}</div>` : ''}
              ${a.instagram ? `<div style="font-size:.72rem;color:var(--teal)">@${a.instagram.replace('@','')}</div>` : ''}
              ${a.shop_website ? `<div style="font-size:.72rem"><a href="${a.shop_website}" target="_blank" style="color:var(--accent);text-decoration:none">↗ ${a.shop_website}</a></div>` : ''}
              <div style="font-size:.78rem;color:var(--muted);margin-top:8px;max-width:400px">${a.shop_description || ''}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
              <span style="font-size:.7rem;color:${statusColor};letter-spacing:.06em;text-transform:uppercase">${a.status}</span>
              ${a.status === 'pending' ? `
                <button onclick="approveVendorApplication('${a.user_id}','${a.id}')" style="padding:6px 14px;background:rgba(210,120,40,.12);border:1px solid var(--green);color:var(--green);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.72rem;cursor:pointer">Approve</button>
                <button onclick="rejectVendorApplication('${a.id}')" style="padding:6px 14px;background:transparent;border:1px solid var(--red);color:var(--red);font-family:'Space Mono','Share Tech Mono',monospace;font-size:.72rem;cursor:pointer">Reject</button>
              ` : ''}
            </div>
          </div>
        </div>`;
      }).join('');
    }

    // ─── Admin: Subsidiary invite tracker (read-only) ──────────────────
    // Lists every friend-of-tester invite code. Admins can SELECT all rows
    // (RLS grants it). Inviter / claimer names are fetched separately to
    // avoid FK-embed ambiguity (two FKs to profiles).
    async function renderAdminSubsidiaryInvites() {
      const el = document.getElementById('adminSubsidiaryInvitesList');
      if (!el) return;
      el.innerHTML = '<div style="color:var(--muted);font-size:.8rem">Loading…</div>';
      try {
        const r = await sb.from('subsidiary_invites')
          .select('id, code, inviter_id, inviter_tier, granted_tier, duration_months, created_at, claimed_at, claimed_by, expires_at, revoked_at')
          .order('created_at', { ascending: false })
          .limit(500);
        if (r.error) {
          const m = String(r.error.message || '');
          el.innerHTML = '<div style="color:var(--red);font-size:.8rem">' +
            (/does not exist|relation|schema cache/i.test(m) ? 'Subsidiary invites table not found — run migration_subsidiary_invites.sql.' : m) + '</div>';
          return;
        }
        const rows = r.data || [];
        const ids = Array.from(new Set([].concat(rows.map(x => x.inviter_id), rows.map(x => x.claimed_by)).filter(Boolean)));
        const pmap = {};
        if (ids.length) {
          const pr = await sb.from('profiles').select('id, username, email').in('id', ids);
          (pr.data || []).forEach(p => { pmap[p.id] = p; });
        }
        const total = rows.length;
        const claimed = rows.filter(x => x.claimed_at).length;
        const revoked = rows.filter(x => x.revoked_at).length;
        const open = total - claimed - revoked;
        const summary = '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;font-family:\'Space Mono\',monospace;font-size:.62rem;color:var(--muted)">' +
          '<span>Total: <strong style="color:var(--text)">' + total + '</strong></span>' +
          '<span>Claimed: <strong style="color:var(--green)">' + claimed + '</strong></span>' +
          '<span>Unclaimed: <strong style="color:var(--accent)">' + open + '</strong></span>' +
          '<span>Revoked: <strong style="color:var(--red)">' + revoked + '</strong></span></div>';
        if (!total) { el.innerHTML = summary + '<div style="color:var(--muted);font-size:.8rem">No subsidiary invites yet.</div>'; return; }
        const nameOf = (id) => { const p = pmap[id]; return p ? (p.username || p.email || String(id).slice(0, 8)) : (id ? String(id).slice(0, 8) : '—'); };
        const fmt = (d) => d ? new Date(d).toLocaleDateString() : '—';
        const list = rows.map(x => {
          let status = 'Unclaimed', color = 'var(--accent)';
          if (x.revoked_at) { status = 'Revoked'; color = 'var(--red)'; }
          else if (x.claimed_at) { status = 'Claimed'; color = 'var(--green)'; }
          return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">' +
            '<div style="min-width:0">' +
              '<div style="font-family:\'Courier New\',monospace;font-size:.8rem;color:var(--text);letter-spacing:.06em">' + x.code + '</div>' +
              '<div style="font-size:.66rem;color:var(--muted);margin-top:2px">from <strong style="color:var(--text)">' + nameOf(x.inviter_id) + '</strong> (' + x.inviter_tier + ') · grants ' + x.granted_tier + ' ' + x.duration_months + 'mo · created ' + fmt(x.created_at) + '</div>' +
              (x.claimed_by ? '<div style="font-size:.66rem;color:var(--muted)">claimed by <strong style="color:var(--text)">' + nameOf(x.claimed_by) + '</strong> ' + fmt(x.claimed_at) + ' · expires ' + fmt(x.expires_at) + '</div>' : '') +
            '</div>' +
            '<span style="font-size:.66rem;color:' + color + ';letter-spacing:.06em;text-transform:uppercase;white-space:nowrap">' + status + '</span>' +
          '</div>';
        }).join('');
        el.innerHTML = summary + '<div style="display:flex;flex-direction:column;gap:8px">' + list + '</div>';
      } catch (e) {
        el.innerHTML = '<div style="color:var(--red);font-size:.8rem">' + (e.message || 'Error') + '</div>';
      }
    }
    window.renderAdminSubsidiaryInvites = renderAdminSubsidiaryInvites;

    function renderAdmin() {
      renderAdminOverview();
      try { renderAdminSubsidiaryInvites(); } catch (_) {}
      loadVendorApplications().then(renderAdminVendorApplications);
      loadAdminClearCollectionUsers();
      renderAdminBetaTesters();
      renderAdminImageReviewQueue();
      // Auto-loads the pending catalog photo contributions panel.
      // No-op when the migration isn't applied (renders a hint).
      if (typeof renderAdminContributionQueue === 'function') {
        renderAdminContributionQueue();
      }
      // Admin moderation panels — disputes, user search, suspended listings.
      loadAdminDisputes();
      loadSuspendedListings();
      // Deep-link handler: emails / notifications use ?admin=disputes&order=xxx.
      maybeFocusAdminDispute();
    }

    // ─── Admin: Disputes panel ─────────────────────────────────────────
    // Pulls every order currently in 'disputed' status and renders an
    // action card per row. Two paths from here:
    //   - Refund Buyer    → /api/refund-order (admin path, Connect-aware)
    //   - Resolve for Seller → admin_resolve_dispute_for_seller RPC
    var _adminDisputeCache = [];

    // Manually fires the /api/admin-notify-dispute endpoint for the most
    // recent disputed order so the admin can verify Resend is wired up
    // without waiting for a real seller to decline a return. Useful right
    // after configuring RESEND_API_KEY / RESEND_FROM / ADMIN_EMAIL_RECIPIENTS
    // in Vercel — confirms the email fires end-to-end. The in-app
    // notification side fires automatically via the Postgres trigger
    // whenever an order's status flips to 'disputed'; this button only
    // tests the email channel which is client-driven.
    async function sendAdminTestEmail() {
      if (!userIsAdmin()) { showToast('Admins only'); return; }
      try {
        // Test mode — POSTs { test: true } to the endpoint which
        // bypasses the disputed-order DB lookup and fires a synthetic
        // "wiring check" email to ADMIN_EMAIL_RECIPIENTS. Useful for
        // verifying Resend env vars without polluting the DB.
        const sess = await sb.auth.getSession();
        const tok  = sess && sess.data && sess.data.session && sess.data.session.access_token;
        if (!tok) { showToast('Sign in again'); return; }

        showToast('Firing admin-notify-dispute test…');
        const r = await fetch('/api/admin-notify-dispute', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
          body:    JSON.stringify({ test: true }),
        });
        const result = await r.json();
        if (!r.ok) {
          showToast('Endpoint error: ' + (result.error || r.status));
          console.error('[test-email] error response:', result);
          return;
        }
        // Distinguish the two soft-failure modes:
        //   emailed=0 with skipped='resend_not_configured' → env vars missing
        //   emailed=0 with skipped='no_admin_emails' → recipient list is empty
        //   emailed=N → success, email actually sent
        if (result.emailed > 0) {
          showToast('Email sent to ' + result.emailed + ' admin(s). Check inboxes.');
        } else if (result.skipped === 'resend_not_configured') {
          showToast('Resend not configured — set RESEND_API_KEY + RESEND_FROM in Vercel.');
        } else if (result.skipped === 'no_admin_emails') {
          showToast('No admin recipients found. Set ADMIN_EMAIL_RECIPIENTS in Vercel.');
        } else {
          showToast('Endpoint returned: emailed=' + result.emailed + ' skipped=' + result.skipped);
        }
        console.log('[test-email] response:', result);
      } catch (e) {
        console.error('[test-email] threw:', e);
        showToast('Test email failed: ' + (e.message || ''));
      }
    }

    async function loadAdminDisputes() {
      const host = document.getElementById('adminDisputesList');
      if (!host) return;
      if (!userIsAdmin()) { host.innerHTML = '<div style="color:var(--muted);font-size:.8rem">Admins only.</div>'; return; }
      host.innerHTML = '<div style="color:var(--muted);font-size:.8rem">Loading…</div>';
      try {
        const { data, error } = await sb
          .from('orders')
          .select('id, status, amount, created_at, buyer_id, seller_id, listing_id, return_reason, return_reason_detail, return_requested_at, disputed_at, stripe_payment_intent, payment_route')
          .eq('status', 'disputed')
          .order('disputed_at', { ascending: false })
          .limit(100);
        if (error) throw error;
        _adminDisputeCache = data || [];
        // Hydrate buyer/seller names + listing names in parallel.
        const userIds = Array.from(new Set([].concat(
          _adminDisputeCache.map(d => d.buyer_id),
          _adminDisputeCache.map(d => d.seller_id),
        ).filter(Boolean)));
        const listingIds = Array.from(new Set(_adminDisputeCache.map(d => d.listing_id).filter(Boolean)));
        const [{ data: profs }, { data: lsts }] = await Promise.all([
          userIds.length    ? sb.from('profiles').select('id, name, username, email').in('id', userIds)         : Promise.resolve({ data: [] }),
          listingIds.length ? sb.from('listings').select('id, name, photos').in('id', listingIds)               : Promise.resolve({ data: [] }),
        ]);
        const pm = {}; (profs || []).forEach(p => pm[p.id] = p);
        const lm = {}; (lsts  || []).forEach(l => lm[l.id] = l);
        renderAdminDisputesList(pm, lm);
      } catch (e) {
        console.error('[admin-disputes] load failed:', e);
        host.innerHTML = '<div style="color:var(--red);font-size:.78rem">Failed to load disputes: ' + (e.message || e) + '</div>';
      }
    }

    function renderAdminDisputesList(profileMap, listingMap) {
      const host  = document.getElementById('adminDisputesList');
      const count = document.getElementById('adminDisputesCount');
      if (count) count.textContent = '(' + _adminDisputeCache.length + ')';
      if (!host) return;
      if (!_adminDisputeCache.length) {
        host.innerHTML = '<div style="color:var(--muted);font-size:.85rem;padding:14px 0;text-align:center">No open disputes. Nice.</div>';
        return;
      }
      const reasonLabels = {
        not_as_described: 'Not as described',
        damaged:          'Arrived damaged',
        never_arrived:    'Never arrived',
        wrong_item:       'Wrong item',
        other:            'Other',
      };
      host.innerHTML = _adminDisputeCache.map(function(o) {
        const buyer  = profileMap[o.buyer_id]  || {};
        const seller = profileMap[o.seller_id] || {};
        const listng = listingMap[o.listing_id] || {};
        const short  = String(o.id).slice(0, 8).toUpperCase();
        const reason = reasonLabels[o.return_reason] || o.return_reason || 'unspecified';
        const detail = String(o.return_reason_detail || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const photo  = (listng.photos && listng.photos[0]) ? listng.photos[0] : '';
        const buyerName  = buyer.name  || buyer.username  || buyer.email  || 'Buyer';
        const sellerName = seller.name || seller.username || seller.email || 'Seller';
        const disputedDate = o.disputed_at ? new Date(o.disputed_at).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' }) : '';
        return ''
          + '<div id="admin-dispute-' + o.id + '" style="padding:14px;border:1px solid var(--border);background:var(--surface2);margin-bottom:10px">'
          +   '<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">'
          +     (photo ? '<img src="' + photo + '" style="width:60px;height:60px;object-fit:cover;border:1px solid var(--border);flex-shrink:0" alt="" / loading="lazy" decoding="async">' : '')
          +     '<div style="flex:1;min-width:240px">'
          +       '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px">'
          +         '<div style="color:var(--text);font-size:.92rem;font-weight:700">' + (listng.name || 'Listing') + '</div>'
          +         '<div style="font-family:\'Space Mono\',monospace;color:var(--muted);font-size:.7rem">#' + short + ' &middot; $' + (o.amount || 0).toFixed(2) + '</div>'
          +       '</div>'
          +       '<div style="font-size:.72rem;color:var(--muted);margin-bottom:6px">'
          +         'Buyer: <span style="color:var(--text)">' + buyerName + '</span>'
          +         ' &middot; Seller: <span style="color:var(--text)">' + sellerName + '</span>'
          +         ' &middot; Disputed: ' + disputedDate
          +       '</div>'
          +       '<div style="padding:8px 10px;border-left:3px solid var(--yellow);background:rgba(255,217,61,.06);font-size:.74rem;color:var(--muted);line-height:1.55;margin-top:6px">'
          +         '<div style="color:var(--yellow);font-weight:700;letter-spacing:.04em;margin-bottom:2px">' + reason.toUpperCase() + '</div>'
          +         (detail ? '<div style="color:var(--text)">"' + detail + '"</div>' : '')
          +       '</div>'
          +     '</div>'
          +     '<div style="display:flex;flex-direction:column;gap:6px;min-width:170px">'
          +       '<button type="button" onclick="adminResolveDisputeForBuyer(\'' + o.id + '\')" '
          +         'style="padding:8px 12px;background:var(--red);color:var(--surface);border:none;font-family:\'Space Mono\',monospace;font-size:.72rem;font-weight:700;cursor:pointer">'
          +         'Refund Buyer'
          +       '</button>'
          +       '<button type="button" onclick="adminResolveDisputeForSeller(\'' + o.id + '\')" '
          +         'style="padding:8px 12px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-family:\'Space Mono\',monospace;font-size:.72rem;cursor:pointer">'
          +         'Resolve for Seller'
          +       '</button>'
          +     '</div>'
          +   '</div>'
          + '</div>';
      }).join('');
    }

    async function adminResolveDisputeForBuyer(orderId) {
      if (!confirm('Refund the buyer in full? This issues a Stripe refund (reverses the application fee on Connect orders) and restores the listing. Cannot be undone.')) return;
      try {
        const sess = await sb.auth.getSession();
        const tok  = sess && sess.data && sess.data.session && sess.data.session.access_token;
        if (!tok) { showToast('Sign in again'); return; }
        showToast('Refunding…');
        const r = await fetch('/api/refund-order', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
          body:    JSON.stringify({ orderId: orderId, reason: 'requested_by_customer' }),
        });
        const data = await r.json();
        if (!r.ok || !data.success) throw new Error(data.error || 'Refund failed');
        showToast('Refunded $' + (data.amount || 0).toFixed(2) + '.');
        loadAdminDisputes();
      } catch (e) {
        console.error('[admin-refund] error:', e);
        showToast('Refund failed: ' + (e.message || ''));
      }
    }

    async function adminResolveDisputeForSeller(orderId) {
      const note = prompt('Resolution note (visible to buyer + seller). Required.\n\nExample: "Reviewed listing photos vs. buyer images — wear matches what was disclosed."');
      if (!note || note.trim().length < 10) {
        if (note !== null) showToast('Note must be at least 10 characters.');
        return;
      }
      try {
        const { error } = await sb.rpc('admin_resolve_dispute_for_seller', {
          p_order_id: orderId,
          p_note:     note.trim(),
        });
        if (error) throw error;
        showToast('Dispute closed in seller\'s favor.');
        loadAdminDisputes();
      } catch (e) {
        console.error('[admin-resolve] error:', e);
        showToast('Resolve failed: ' + (e.message || ''));
      }
    }

    // ─── Admin: User search + ban/unban ────────────────────────────────
    async function searchAdminUsers() {
      const host = document.getElementById('adminUserResults');
      const q    = document.getElementById('adminUserSearch').value.trim();
      if (!host) return;
      if (!q) { host.innerHTML = '<div style="color:var(--muted);font-size:.78rem">Type an email or username and hit Search.</div>'; return; }
      host.innerHTML = '<div style="color:var(--muted);font-size:.78rem">Searching…</div>';
      try {
        // ILIKE on email OR username — PostgREST OR filter syntax.
        const { data, error } = await sb
          .from('profiles')
          .select('id, email, username, name, is_admin, is_banned, banned_reason, banned_at, is_deleted, subscription_tier, created_at')
          .or('email.ilike.%' + q + '%,username.ilike.%' + q + '%,name.ilike.%' + q + '%')
          .limit(20);
        if (error) throw error;
        renderAdminUserResults(data || []);
      } catch (e) {
        console.error('[admin-user-search] failed:', e);
        host.innerHTML = '<div style="color:var(--red);font-size:.78rem">Search failed: ' + (e.message || '') + '</div>';
      }
    }

    function renderAdminUserResults(rows) {
      const host = document.getElementById('adminUserResults');
      if (!host) return;
      if (!rows.length) { host.innerHTML = '<div style="color:var(--muted);font-size:.78rem">No matches.</div>'; return; }
      host.innerHTML = rows.map(function(u) {
        const label = u.name || u.username || u.email || u.id.slice(0,8);
        const tierBadge = u.subscription_tier ? '<span style="font-family:\'Space Mono\',monospace;font-size:.62rem;letter-spacing:.06em;padding:2px 6px;border:1px solid var(--border);color:var(--muted);margin-left:6px">' + u.subscription_tier.toUpperCase() + '</span>' : '';
        const flags = [];
        if (u.is_admin)   flags.push('<span style="color:var(--copper);font-size:.66rem">ADMIN</span>');
        if (u.is_banned)  flags.push('<span style="color:var(--red);font-size:.66rem">BANNED</span>');
        if (u.is_deleted) flags.push('<span style="color:var(--muted);font-size:.66rem">DELETED</span>');
        const flagHtml = flags.length ? ' &middot; ' + flags.join(' &middot; ') : '';
        const bannedNote = u.is_banned && u.banned_reason
          ? '<div style="font-size:.7rem;color:var(--muted);margin-top:4px;font-style:italic">Reason: "' + String(u.banned_reason).replace(/</g,'&lt;') + '"</div>'
          : '';
        const banBtn = u.is_admin
          ? '<span style="color:var(--muted);font-size:.7rem">Cannot ban admins</span>'
          : (u.is_banned
              ? '<button type="button" onclick="adminUnbanUser(\'' + u.id + '\')" style="padding:6px 12px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-family:\'Space Mono\',monospace;font-size:.7rem;cursor:pointer">Unban</button>'
              : '<button type="button" onclick="adminBanUser(\'' + u.id + '\',\'' + (u.username || u.email || '').replace(/\'/g,"\\'") + '\')" style="padding:6px 12px;border:1px solid var(--red);background:transparent;color:var(--red);font-family:\'Space Mono\',monospace;font-size:.7rem;cursor:pointer">Ban</button>');
        return ''
          + '<div style="padding:10px 14px;border:1px solid var(--border);background:var(--surface2);display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap">'
          +   '<div style="flex:1;min-width:220px">'
          +     '<div style="color:var(--text);font-size:.85rem">' + label + tierBadge + flagHtml + '</div>'
          +     '<div style="color:var(--muted);font-size:.7rem;font-family:\'Space Mono\',monospace;margin-top:3px">' + (u.email || '') + ' &middot; ' + u.id + '</div>'
          +     bannedNote
          +   '</div>'
          +   '<div>' + banBtn + '</div>'
          + '</div>';
      }).join('');
    }

    async function adminBanUser(userId, label) {
      const reason = prompt('Ban ' + (label || 'this user') + '?\n\nEnter a reason (required, visible internally; user just sees "account suspended"):');
      if (!reason || reason.trim().length < 5) {
        if (reason !== null) showToast('Reason must be at least 5 characters.');
        return;
      }
      try {
        const { error } = await sb.rpc('admin_set_user_banned', {
          p_user_id: userId,
          p_banned:  true,
          p_reason:  reason.trim(),
        });
        if (error) throw error;
        showToast('User banned. Active listings suspended.');
        searchAdminUsers();
        loadSuspendedListings();
      } catch (e) {
        console.error('[admin-ban] error:', e);
        showToast('Ban failed: ' + (e.message || ''));
      }
    }

    async function adminUnbanUser(userId) {
      if (!confirm('Unban this user? They will be able to sign in immediately. Previously-suspended listings stay suspended — restore those individually.')) return;
      try {
        const { error } = await sb.rpc('admin_set_user_banned', {
          p_user_id: userId,
          p_banned:  false,
          p_reason:  null,
        });
        if (error) throw error;
        showToast('User unbanned.');
        searchAdminUsers();
      } catch (e) {
        console.error('[admin-unban] error:', e);
        showToast('Unban failed: ' + (e.message || ''));
      }
    }

    // ─── Admin: Suspended listings list + restore ──────────────────────
    async function loadSuspendedListings() {
      const host = document.getElementById('adminSuspendedList');
      if (!host) return;
      if (!userIsAdmin()) { host.innerHTML = '<div style="color:var(--muted);font-size:.8rem">Admins only.</div>'; return; }
      host.innerHTML = '<div style="color:var(--muted);font-size:.8rem">Loading…</div>';
      try {
        const { data, error } = await sb
          .from('listings')
          .select('id, name, photos, suspended_reason, suspended_at, seller_id, value')
          .eq('status', 'suspended')
          .order('suspended_at', { ascending: false })
          .limit(100);
        if (error) throw error;
        const rows = data || [];
        if (!rows.length) { host.innerHTML = '<div style="color:var(--muted);font-size:.85rem;padding:8px 0">No suspended listings.</div>'; return; }
        host.innerHTML = rows.map(function(l) {
          const photo = (l.photos && l.photos[0]) ? l.photos[0] : '';
          const price = (l.list_price != null ? l.list_price : l.value) || 0;
          const when  = l.suspended_at ? new Date(l.suspended_at).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' }) : '';
          const reason = String(l.suspended_reason || '').replace(/</g,'&lt;');
          return ''
            + '<div style="padding:10px 14px;border:1px solid var(--border);background:var(--surface2);display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px">'
            +   (photo ? '<img src="' + photo + '" style="width:48px;height:48px;object-fit:cover;border:1px solid var(--border)" / loading="lazy" decoding="async">' : '')
            +   '<div style="flex:1;min-width:220px">'
            +     '<div style="color:var(--text);font-size:.85rem">' + (l.name || 'Listing') + ' <span style="color:var(--muted);font-size:.72rem">&middot; $' + price.toFixed(2) + '</span></div>'
            +     '<div style="color:var(--muted);font-size:.7rem;margin-top:3px">' + when + (reason ? ' &middot; <em>"' + reason + '"</em>' : '') + '</div>'
            +   '</div>'
            +   '<button type="button" onclick="adminRestoreListing(\'' + l.id + '\')" style="padding:6px 12px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-family:\'Space Mono\',monospace;font-size:.7rem;cursor:pointer">Restore</button>'
            +   '<button type="button" onclick="adminSuspendListingPrompt(\'' + l.id + '\')" style="padding:6px 12px;border:1px solid var(--border);background:transparent;color:var(--muted);font-family:\'Space Mono\',monospace;font-size:.7rem;cursor:pointer">Edit reason</button>'
            + '</div>';
        }).join('');
      } catch (e) {
        console.error('[admin-suspended] load failed:', e);
        host.innerHTML = '<div style="color:var(--red);font-size:.78rem">Failed to load: ' + (e.message || '') + '</div>';
      }
    }

    async function adminSuspendListingPrompt(listingId) {
      const reason = prompt('Reason for suspending this listing? (Surfaced to the seller so they know what to fix.)');
      if (!reason || reason.trim().length < 5) {
        if (reason !== null) showToast('Reason must be at least 5 characters.');
        return;
      }
      try {
        const { error } = await sb.rpc('admin_set_listing_suspended', {
          p_listing_id: listingId,
          p_suspended:  true,
          p_reason:     reason.trim(),
        });
        if (error) throw error;
        showToast('Listing suspended.');
        loadSuspendedListings();
        if (typeof renderAdminTable === 'function') renderAdminTable();
      } catch (e) {
        console.error('[admin-suspend] error:', e);
        showToast('Suspend failed: ' + (e.message || ''));
      }
    }

    async function adminRestoreListing(listingId) {
      if (!confirm('Restore this listing to the marketplace?')) return;
      try {
        const { error } = await sb.rpc('admin_set_listing_suspended', {
          p_listing_id: listingId,
          p_suspended:  false,
          p_reason:     null,
        });
        if (error) throw error;
        showToast('Listing restored.');
        loadSuspendedListings();
      } catch (e) {
        console.error('[admin-restore] error:', e);
        showToast('Restore failed: ' + (e.message || ''));
      }
    }

    // ─── Admin deep-link handler ───────────────────────────────────────
    // ?admin=disputes&order=<uuid> opens the admin page, scrolls the
    // specific dispute card into view, and gives it a 2s pulse so it's
    // visually obvious which one the email/notification was about.
    function maybeFocusAdminDispute() {
      try {
        const q = new URLSearchParams(location.search);
        if (q.get('admin') !== 'disputes') return;
        const orderId = q.get('order');
        // Clean the query off the URL.
        q.delete('admin'); q.delete('order');
        const newSearch = q.toString();
        history.replaceState(null, '', location.pathname + (newSearch ? '?' + newSearch : '') + location.hash);
        if (!orderId) return;
        // Wait for the dispute list to render then scroll + highlight.
        let tries = 0;
        const tick = setInterval(function() {
          tries++;
          const el = document.getElementById('admin-dispute-' + orderId);
          if (el) {
            clearInterval(tick);
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const orig = el.style.boxShadow;
            el.style.transition = 'box-shadow .3s';
            el.style.boxShadow  = '0 0 0 3px var(--copper)';
            setTimeout(function() { el.style.boxShadow = orig; }, 2400);
          } else if (tries > 30) {
            clearInterval(tick);
          }
        }, 150);
      } catch (_) { /* no-op */ }
    }

    // ── Admin: image-review queue ───────────────────────────────────────
    // Pulls every listing where needs_image_review = true, sorted oldest-
    // flag-first (so backlog gets worked in flag order). Shows a compact
    // row per listing with: thumbnail · name + admin note · "View" + "Clear".
    // View opens the listing's buy-card detail (admin can swap photos in
    // edit flow); Clear toggles the flag off via the existing function.
    async function renderAdminImageReviewQueue() {
      const container = document.getElementById('adminImageReviewQueue');
      if (!container || !currentUser?.is_admin) return;
      container.innerHTML = '<div style="font-size:.6rem;color:var(--muted)">Loading…</div>';
      var res;
      try {
        // Queue now reads from catalog (sealed products + any catalog
        // row admins flag) — see migration_catalog_image_review.sql.
        // Previously queried listings; the flag moved to catalog so
        // every reference to the same product shares one flag state.
        res = await sb.from('catalog')
          .select('id, name, set_name, image_url, product_type, image_review_note, image_review_flagged_at')
          .eq('needs_image_review', true)
          .order('image_review_flagged_at', { ascending: true, nullsFirst: true });
      } catch (e) {
        container.innerHTML = '<div style="font-size:.6rem;color:var(--red)">Query failed — apply migration_catalog_image_review.sql.</div>';
        return;
      }
      if (res.error) {
        // Column-missing error → migration not applied yet
        var msg = String(res.error.message || '');
        if (msg.toLowerCase().indexOf('column') >= 0 || msg.toLowerCase().indexOf('schema') >= 0) {
          container.innerHTML = '<div style="font-size:.6rem;color:var(--red)">Apply <code>migration_catalog_image_review.sql</code> in Supabase before using this queue.</div>';
        } else {
          container.innerHTML = '<div style="font-size:.6rem;color:var(--red)">Error: ' + _escHtml(msg) + '</div>';
        }
        return;
      }
      var rows = res.data || [];
      if (!rows.length) {
        container.innerHTML = '<div style="font-size:.6rem;color:var(--muted)">Queue empty — no catalog rows flagged for image review.</div>';
        return;
      }
      container.innerHTML = rows.map(function(r) {
        var thumb = r.image_url || '';
        var when  = r.image_review_flagged_at
          ? new Date(r.image_review_flagged_at).toLocaleDateString()
          : '—';
        var ptype = (r.product_type || 'single').toUpperCase().replace(/_/g, ' ');
        return '<div style="display:flex;align-items:center;gap:12px;padding:10px;border:1px solid var(--copper-dim);background:rgba(184,115,51,.06)">' +
          (thumb
            ? '<img src="' + thumb + '" alt="" style="width:48px;height:64px;object-fit:cover;border:1px solid var(--border);flex-shrink:0;border-radius:3px" loading="lazy" decoding="async">'
            : '<div style="width:48px;height:64px;background:var(--surface2);border:1px dashed var(--copper-dim);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.7rem">?</div>') +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:.74rem;color:var(--text);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _escHtml(r.name || '(no name)') + '</div>' +
            '<div style="font-size:.6rem;color:var(--muted);margin-top:2px">' + _escHtml(ptype) + ' · ' + _escHtml(r.set_name || '—') + ' · flagged ' + when + '</div>' +
            (r.image_review_note
              ? '<div style="font-size:.6rem;color:var(--copper);margin-top:4px;font-style:italic">"' + _escHtml(r.image_review_note) + '"</div>'
              : '') +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">' +
            '<button onclick="openSealedProductDetail(\'' + _escJsAttr(r.id) + '\')" class="pb-panel-link" style="border-color:var(--copper-dim);color:var(--copper);font-size:.58rem;padding:4px 10px">VIEW</button>' +
            '<button onclick="flagCatalogImage(\'' + _escJsAttr(r.id) + '\', true)" class="pb-panel-link" style="border-color:var(--border);color:var(--muted);font-size:.58rem;padding:4px 10px">CLEAR</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    async function loadAdminClearCollectionUsers() {
      const container = document.getElementById('adminClearCollectionUsers');
      if (!container || !currentUser?.is_admin) return;

      // Load profiles with card counts
      const { data: profiles } = await sb.from('profiles').select('id, email, username').order('email');
      if (!profiles || !profiles.length) {
        container.innerHTML = '<div style="font-size:.6rem;color:var(--muted)">No users found.</div>';
        return;
      }

      // Get card counts per user
      const { data: counts } = await sb.from('collection_items').select('user_id');
      const countMap = {};
      (counts || []).forEach(r => { countMap[r.user_id] = (countMap[r.user_id] || 0) + 1; });

      container.innerHTML = profiles.map(p => {
        const n = countMap[p.id] || 0;
        const label = p.username || p.email || p.id.slice(0, 8);
        return `<div style="display:flex;align-items:center;gap:12px;padding:8px 10px;border:1px solid rgba(255,60,60,.2);background:rgba(0,0,0,.2)">
          <div style="flex:1;font-family:'Space Mono','Share Tech Mono',monospace;font-size:.65rem;color:var(--text)">${label}</div>
          <div style="font-size:.6rem;color:var(--muted);white-space:nowrap">${n} card${n !== 1 ? 's' : ''}</div>
          <button onclick="adminClearUserCollection('${p.id}','${label.replace(/'/g,"\\'")}',${n})"
            ${n === 0 ? 'disabled' : ''}
            style="font-family:'Space Mono','Share Tech Mono',monospace;font-size:.55rem;letter-spacing:.06em;padding:4px 10px;border:1px solid rgba(255,60,60,.5);background:transparent;color:rgba(255,100,100,.85);cursor:${n===0?'not-allowed':'pointer'};opacity:${n===0?'.4':'1'};white-space:nowrap;transition:all .15s"
            onmouseover="if(${n}>0){this.style.background='rgba(255,60,60,.12)'}" onmouseout="this.style.background='transparent'">
            Delete ${n > 0 ? n + ' cards' : 'cards'}
          </button>
        </div>`;
      }).join('');
    }

    // ── Catalog Image Contribution Queue ─────────────────────────
    // Admin queue for user-submitted catalog photos. Each row shows
    // side-by-side: contributor's photo + card metadata + current
    // catalog image (likely NULL since this flow only triggers when
    // image_url is missing). Buttons fire apply_image_contribution
    // or reject_image_contribution RPCs.
    async function renderAdminContributionQueue() {
      const container = document.getElementById('adminContributionQueue');
      if (!container || !currentUser?.is_admin) return;
      container.innerHTML = '<div style="font-size:.6rem;color:var(--muted)">Loading…</div>';

      // Pull pending submissions with joined catalog + profile rows
      // so we can show everything without a second round-trip per row.
      const res = await sb.from('catalog_image_contributions')
        .select(`
          id, user_id, catalog_id, image_url, image_width, image_height,
          submitted_at, notes,
          profiles:user_id ( username, email, subscription_tier ),
          catalog:catalog_id ( name, set_name, set_code, card_number, image_url, product_type, game_type )
        `)
        .eq('status', 'pending')
        .order('submitted_at', { ascending: true })
        .limit(50);

      if (res.error) {
        const msg = String(res.error.message || '');
        if (/relation .*catalog_image_contributions.* does not exist/i.test(msg)) {
          container.innerHTML = '<div style="font-size:.6rem;color:var(--red)">Apply <code>migration_catalog_image_contributions.sql</code> in Supabase before using this queue.</div>';
        } else {
          container.innerHTML = '<div style="font-size:.6rem;color:var(--red)">Error: ' + _escHtml(msg) + '</div>';
        }
        return;
      }

      const rows = res.data || [];
      if (!rows.length) {
        container.innerHTML = '<div style="font-size:.6rem;color:var(--muted)">Queue empty — no pending contributions.</div>';
        return;
      }

      container.innerHTML = rows.map(function(r) {
        const cat   = r.catalog || {};
        const prof  = r.profiles || {};
        const dims  = (r.image_width && r.image_height)
          ? r.image_width + '×' + r.image_height : '—';
        const tier  = String(prof.subscription_tier || 'free').toUpperCase();
        const setLine = [cat.set_name, cat.card_number ? '#' + cat.card_number : '']
          .filter(Boolean).join(' · ');
        const submittedAgo = (function() {
          const ms = Date.now() - new Date(r.submitted_at).getTime();
          const h  = Math.floor(ms / 3600000);
          if (h < 1) return Math.max(1, Math.floor(ms / 60000)) + 'm ago';
          if (h < 24) return h + 'h ago';
          return Math.floor(h / 24) + 'd ago';
        })();
        return ''
        + '<div style="display:flex;gap:12px;padding:12px;border:1px solid var(--accent);background:rgba(26,199,160,.04);border-radius:4px">'
        +   '<div style="flex-shrink:0">'
        +     '<div style="font-size:.5rem;color:var(--accent);letter-spacing:.08em;margin-bottom:4px">SUBMITTED</div>'
        +     '<img src="' + _escHtml(r.image_url) + '" alt="" loading="lazy" style="width:140px;height:auto;border:1px solid var(--accent);border-radius:3px;display:block">'
        +     '<div style="font-size:.55rem;color:var(--muted);margin-top:4px;text-align:center">' + _escHtml(dims) + '</div>'
        +   '</div>'
        +   '<div style="flex:1;min-width:0">'
        +     '<div style="font-size:.78rem;color:var(--text);font-weight:700;margin-bottom:3px">' + _escHtml(cat.name || '(unknown card)') + '</div>'
        +     (setLine ? '<div style="font-size:.62rem;color:var(--muted);margin-bottom:8px">' + _escHtml(setLine) + '</div>' : '')
        +     '<div style="font-size:.58rem;color:var(--muted);margin-bottom:8px;line-height:1.5">'
        +       '<div><span style="color:var(--accent)">By</span> ' + _escHtml(prof.username || prof.email || r.user_id.slice(0, 8)) + ' (' + _escHtml(tier) + ')</div>'
        +       '<div><span style="color:var(--accent)">When</span> ' + _escHtml(submittedAgo) + '</div>'
        +       '<div><span style="color:var(--accent)">Catalog id</span> <code style="color:var(--muted);font-size:.55rem">' + _escHtml(r.catalog_id) + '</code></div>'
        +       (cat.image_url ? '<div style="color:var(--copper);margin-top:4px">Catalog row ALREADY has an image — this would replace it.</div>' : '')
        +       (r.notes ? '<div style="margin-top:4px;color:var(--text)">Note: <em>' + _escHtml(r.notes) + '</em></div>' : '')
        +     '</div>'
        +     '<div style="display:flex;gap:6px">'
        +       '<button onclick="adminApproveContribution(\'' + _escJsAttr(r.id) + '\')" '
        +         'style="padding:7px 14px;border:1px solid var(--accent);background:var(--accent);color:var(--text-on-accent);font-family:\'Space Mono\',monospace;font-size:.62rem;font-weight:700;cursor:pointer;letter-spacing:.06em">'
        +         'APPROVE'
        +       '</button>'
        +       '<button onclick="adminRejectContribution(\'' + _escJsAttr(r.id) + '\')" '
        +         'style="padding:7px 14px;border:1px solid rgba(255,80,80,.5);background:transparent;color:rgba(255,100,100,.85);font-family:\'Space Mono\',monospace;font-size:.62rem;cursor:pointer;letter-spacing:.06em">'
        +         'REJECT'
        +       '</button>'
        +       (cat.image_url
          ? '<a href="' + _escHtml(cat.image_url) + '" target="_blank" rel="noopener" '
            + 'style="padding:7px 14px;border:1px solid var(--copper-dim);background:transparent;color:var(--copper);font-family:\'Space Mono\',monospace;font-size:.62rem;cursor:pointer;letter-spacing:.06em;text-decoration:none;display:inline-block">'
            + 'CURRENT IMG'
            + '</a>'
          : '')
        +     '</div>'
        +   '</div>'
        + '</div>';
      }).join('');
    }

    window.renderAdminContributionQueue = renderAdminContributionQueue;

    async function adminApproveContribution(contribId) {
      if (!currentUser?.is_admin) return;
      try {
        const r = await sb.rpc('apply_image_contribution', {
          p_contribution_id: contribId,
          p_reviewer_id:     currentUser.id,
        });
        if (r && r.error) { showToast('Approve failed: ' + r.error.message); return; }
        showToast('Approved — catalog updated');
        renderAdminContributionQueue();
      } catch (e) {
        showToast('Approve failed: ' + (e.message || 'unknown'));
      }
    }
    window.adminApproveContribution = adminApproveContribution;

    async function adminRejectContribution(contribId) {
      if (!currentUser?.is_admin) return;
      const reason = prompt('Reject reason (visible to contributor):', 'Image quality too low / watermarked / wrong card');
      if (!reason) return;
      try {
        const r = await sb.rpc('reject_image_contribution', {
          p_contribution_id: contribId,
          p_reviewer_id:     currentUser.id,
          p_reason:          reason,
        });
        if (r && r.error) { showToast('Reject failed: ' + r.error.message); return; }
        showToast('Rejected');
        renderAdminContributionQueue();
      } catch (e) {
        showToast('Reject failed: ' + (e.message || 'unknown'));
      }
    }
    window.adminRejectContribution = adminRejectContribution;

    async function adminClearUserCollection(userId, label, count) {
      if (!currentUser?.is_admin) return;
      if (!confirm(`Delete all ${count} cards from ${label}'s collection?\n\nThis cannot be undone.`)) return;

      const { error } = await sb
        .from('collection_items')
        .delete()
        .eq('user_id', userId);

      if (error) { showToast('Error: ' + error.message); return; }
      showToast(`Deleted ${count} cards from ${label}'s collection`);
      loadAdminClearCollectionUsers(); // refresh counts
    }

    // ── Admin Card Editor — manages card_reports and card_overrides ──────
    var _adminCardReportsCache = [];

    function _adminSetCRTab(active) {
      var open     = document.getElementById('adminCRTabOpen');
      var resolved = document.getElementById('adminCRTabResolved');
      function activate(el)   { if (el) { el.style.borderColor='var(--copper)'; el.style.background='rgba(184,115,51,.12)'; el.style.color='var(--copper)'; } }
      function deactivate(el) { if (el) { el.style.borderColor='var(--border)'; el.style.background='transparent'; el.style.color='var(--muted)'; } }
      if (active === 'open')     { activate(open); deactivate(resolved); }
      else if (active === 'resolved') { activate(resolved); deactivate(open); }
    }

    async function adminLoadCardReports(filter) {
      if (!currentUser?.is_admin) return;
      var list = document.getElementById('adminCardReportsList');
      if (!list) return;
      _adminSetCRTab(filter);
      list.innerHTML = '<div style="font-size:.62rem;color:rgba(26,199,160,.4);letter-spacing:.08em">Loading reports…</div>';

      var query = sb.from('card_reports').select('*').order('created_at', { ascending: false }).limit(60);
      if (filter === 'open')     query = query.eq('status', 'open');
      if (filter === 'resolved') query = query.eq('status', 'resolved');
      var res = await query;
      if (res.error) {
        var msg = (res.error.message || '').toLowerCase();
        if (msg.indexOf('relation') !== -1 || msg.indexOf('does not exist') !== -1) {
          printAdminCardSQL();
          list.innerHTML = '<div style="font-size:.7rem;color:#ff6b6b">Migration required — see console for SQL.</div>';
          return;
        }
        list.innerHTML = '<div style="font-size:.7rem;color:#ff6b6b">Error: ' + _escHtml(res.error.message) + '</div>';
        return;
      }

      _adminCardReportsCache = res.data || [];
      if (!_adminCardReportsCache.length) {
        list.innerHTML = '<div style="font-size:.7rem;color:var(--muted);font-style:italic;padding:8px 0">No ' + filter + ' reports.</div>';
        return;
      }

      // Look up reporter usernames in one query for the rendered list.
      var userIds = Array.from(new Set(_adminCardReportsCache.map(function(r) { return r.user_id; }).filter(Boolean)));
      var nameMap = {};
      if (userIds.length) {
        try {
          var pf = await sb.from('profiles').select('id, username, name').in('id', userIds);
          (pf.data || []).forEach(function(p) { nameMap[p.id] = p.username || p.name || ''; });
        } catch(_) {}
      }

      list.innerHTML = _adminCardReportsCache.map(function(r) {
        var who   = nameMap[r.user_id] ? '@' + _escHtml(nameMap[r.user_id]) : 'Anonymous';
        var when  = r.created_at ? new Date(r.created_at).toLocaleString() : '';
        var card  = (r.card_name || 'Unknown card') + (r.set_name ? ' · ' + r.set_name : '');
        var apiId = r.api_card_id || '';
        var statusBadge = r.status === 'resolved'
          ? '<span style="font-size:.55rem;color:var(--green);border:1px solid var(--green);padding:1px 6px;letter-spacing:.06em">RESOLVED</span>'
          : '<span style="font-size:.55rem;color:var(--copper);border:1px solid var(--copper);padding:1px 6px;letter-spacing:.06em">OPEN</span>';
        return (
          '<div style="border:1px solid var(--border);background:var(--surface2);padding:10px 12px;font-family:\'Space Mono\',monospace">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">' +
              '<div style="flex:1;min-width:0">' +
                '<div style="display:flex;gap:8px;align-items:center;font-size:.62rem;color:var(--muted);margin-bottom:4px">' +
                  statusBadge +
                  '<span>' + _escHtml(who) + '</span>' +
                  '<span>·</span>' +
                  '<span>' + _escHtml(when) + '</span>' +
                '</div>' +
                '<div style="font-size:.78rem;font-weight:600;color:var(--text);margin-bottom:2px">' + _escHtml(card) + '</div>' +
                (apiId ? '<div style="font-size:.58rem;color:rgba(26,199,160,.5)">api_card_id: ' + _escHtml(apiId) + '</div>' : '') +
                '<div style="font-size:.7rem;color:rgba(210,240,255,.78);margin-top:6px;line-height:1.5;white-space:pre-wrap;border-left:2px solid rgba(184,115,51,.4);padding-left:8px">' + _escHtml(r.description || '') + '</div>' +
              '</div>' +
              '<div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">' +
                (r.api_card_id
                  ? '<button onclick="adminOpenCardOverrideEditor(\'' + r.api_card_id + '\',\'' + r.id + '\')" style="font-size:.6rem;padding:5px 11px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer;font-family:inherit;letter-spacing:.04em">Edit Card Data</button>'
                  : '<button disabled style="font-size:.6rem;padding:5px 11px;border:1px solid var(--border);background:transparent;color:var(--muted);font-family:inherit;letter-spacing:.04em;cursor:not-allowed" title="No api_card_id — manual override only">No API ID</button>'
                ) +
                (r.status === 'open'
                  ? '<button onclick="adminResolveCardReport(\'' + r.id + '\', \'dismissed\')" style="font-size:.55rem;padding:4px 10px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-family:inherit;letter-spacing:.04em">Dismiss</button>'
                  : '<button onclick="adminResolveCardReport(\'' + r.id + '\', \'open\')" style="font-size:.55rem;padding:4px 10px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-family:inherit;letter-spacing:.04em">Reopen</button>'
                ) +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }).join('');
    }

    async function adminResolveCardReport(reportId, newStatus) {
      if (!currentUser?.is_admin) return;
      var patch = { status: newStatus };
      if (newStatus === 'resolved') {
        patch.resolved_at = new Date().toISOString();
        patch.resolved_by = currentUser.id;
      } else if (newStatus === 'open') {
        patch.resolved_at = null;
        patch.resolved_by = null;
      }
      var res = await sb.from('card_reports').update(patch).eq('id', reportId);
      if (res.error) { showToast('Error: ' + res.error.message); return; }
      showToast('Report ' + newStatus);
      // Refresh whichever tab is currently active
      var activeOpen = document.getElementById('adminCRTabOpen');
      var current = (activeOpen && activeOpen.style.background.indexOf('184,115,51') !== -1) ? 'open' : 'resolved';
      adminLoadCardReports(current);
    }

    // Override editor — opens an inline form keyed by api_card_id.
    // Pass reportId to auto-resolve the linked report on save.
    async function adminOpenCardOverrideEditor(apiCardId, reportId) {
      if (!currentUser?.is_admin) return;
      // If apiCardId is null we're in "manual" mode — let the admin type it
      var prompted = apiCardId;
      if (!prompted) {
        prompted = prompt('Enter the api_card_id of the card to override (e.g. xy7-54):');
        if (!prompted) return;
        prompted = prompted.trim();
      }

      // Fetch existing override (if any) + the live API data for context
      var override = null, apiData = null;
      try {
        var ov = await sb.from('card_overrides').select('*').eq('api_card_id', prompted).maybeSingle();
        override = ov.data || null;
      } catch(_) {}
      try {
        var ar = await fetch('https://api.pokemontcg.io/v2/cards/' + encodeURIComponent(prompted));
        if (ar.ok) {
          var aj = await ar.json();
          apiData = aj.data || null;
        }
      } catch(_) {}

      // Render the editor inline at the top of the reports list
      var list = document.getElementById('adminCardReportsList');
      if (!list) return;
      var current = function(field, fallback) {
        if (override && override[field] != null && override[field] !== '') return override[field];
        return fallback != null ? fallback : '';
      };
      var hint = function(label, val) { return '<div style="font-size:.55rem;color:var(--muted);margin-top:2px">' + label + ': <span style="color:rgba(210,240,255,.6)">' + (val ? _escHtml(String(val)) : '<em>none</em>') + '</span></div>'; };

      var apiName  = apiData ? apiData.name : '';
      var apiSet   = apiData && apiData.set ? (apiData.set.name || '') : '';
      var apiCode  = apiData && apiData.set ? (apiData.set.id || '') : '';
      var apiNum   = apiData ? apiData.number : '';
      var apiImg   = apiData && apiData.images ? (apiData.images.large || apiData.images.small || '') : '';
      var apiRare  = apiData ? apiData.rarity : '';

      var editor =
        '<div id="adminOverrideEditor" style="border:1px solid var(--copper);background:rgba(184,115,51,.06);padding:14px 16px;font-family:\'Space Mono\',monospace">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">' +
            '<div style="font-size:.7rem;color:var(--copper);letter-spacing:.08em;font-weight:700">EDITING OVERRIDE · ' + _escHtml(prompted) + '</div>' +
            '<button onclick="document.getElementById(\'adminOverrideEditor\').remove()" style="font-size:.55rem;padding:3px 9px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-family:inherit">Close Editor</button>' +
          '</div>' +
          (apiData
            ? '<div style="display:flex;gap:12px;margin-bottom:12px">' +
                (apiImg ? '<img src="' + apiImg + '" style="width:80px;height:auto;flex-shrink:0;border:1px solid var(--border)" alt="" loading="lazy" decoding="async">' : '') +
                '<div style="flex:1;font-size:.6rem;color:var(--muted);line-height:1.6">' +
                  '<div style="color:var(--text);font-size:.66rem;font-weight:600;margin-bottom:2px">CATALOG (live):</div>' +
                  '<div>' + _escHtml(apiName || '—') + '</div>' +
                  '<div>' + _escHtml(apiSet || '—') + (apiNum ? ' · #' + _escHtml(apiNum) : '') + '</div>' +
                  '<div>Rarity: ' + _escHtml(apiRare || '—') + '</div>' +
                '</div>' +
              '</div>'
            : '<div style="font-size:.62rem;color:#ff8888;margin-bottom:10px">No live catalog data — pokemontcg.io returned nothing for this id. Override fields will be applied as-is.</div>') +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">' +
            _ovField('Card name',     'ovName',  current('card_name', ''),       apiName) +
            _ovField('Set name',      'ovSet',   current('set_name', ''),        apiSet) +
            _ovField('Set code',      'ovCode',  current('set_code', ''),        apiCode) +
            _ovField('Card number',   'ovNum',   current('card_number', ''),     apiNum) +
            _ovField('Rarity',        'ovRare',  current('rarity', ''),          apiRare) +
            _ovField('Image URL',     'ovImg',   current('card_image_url', ''),  apiImg) +
          '</div>' +
          '<label style="font-size:.58rem;color:var(--muted);letter-spacing:.06em;display:block;margin-bottom:4px">Admin notes (optional)</label>' +
          '<textarea id="ovNotes" rows="2" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 8px;font-family:inherit;font-size:.65rem;box-sizing:border-box;margin-bottom:10px">' + _escHtml(current('notes', '')) + '</textarea>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button onclick="adminSaveCardOverride(\'' + prompted + '\',' + (reportId ? '\'' + reportId + '\'' : 'null') + ')" style="font-size:.65rem;padding:7px 14px;border:1px solid var(--copper);background:var(--copper);color:#000;cursor:pointer;font-family:inherit;letter-spacing:.04em;font-weight:700">Save Override' + (reportId ? ' + Resolve Report' : '') + '</button>' +
            (override
              ? '<button onclick="adminDeleteCardOverride(\'' + prompted + '\')" style="font-size:.6rem;padding:7px 14px;border:1px solid #ff6b6b;background:transparent;color:#ff6b6b;cursor:pointer;font-family:inherit;letter-spacing:.04em">Delete Override</button>'
              : '') +
            '<button onclick="adminPrefillFromCatalog(' + (apiData ? 'true' : 'false') + ')" style="font-size:.6rem;padding:7px 14px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-family:inherit;letter-spacing:.04em">Prefill from Catalog</button>' +
          '</div>' +
          '<div id="ovStatus" style="font-size:.62rem;color:var(--muted);margin-top:8px;min-height:1em"></div>' +
        '</div>';

      // Insert at the top of the reports list, leaving the report list visible below.
      var existing = document.getElementById('adminOverrideEditor');
      if (existing) existing.remove();
      list.insertAdjacentHTML('afterbegin', editor);
      // Stash live API data so prefill button works without refetching
      window._adminLastApiData = apiData;
    }

    function _ovField(label, id, value, placeholder) {
      var safeVal  = _escHtml(value || '');
      var safePh   = _escHtml(placeholder || '');
      return (
        '<div>' +
          '<label style="font-size:.58rem;color:var(--muted);letter-spacing:.06em;display:block;margin-bottom:3px">' + label + '</label>' +
          '<input type="text" id="' + id + '" value="' + safeVal + '" placeholder="' + safePh + '" ' +
            'style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 8px;font-family:inherit;font-size:.66rem;box-sizing:border-box">' +
        '</div>'
      );
    }

    function adminPrefillFromCatalog(haveApi) {
      if (!haveApi) { showToast('No catalog data to prefill from'); return; }
      var ad = window._adminLastApiData;
      if (!ad) return;
      function setIf(id, val) { var el = document.getElementById(id); if (el && val) el.value = val; }
      setIf('ovName', ad.name);
      setIf('ovSet',  ad.set && ad.set.name);
      setIf('ovCode', ad.set && ad.set.id);
      setIf('ovNum',  ad.number);
      setIf('ovRare', ad.rarity);
      setIf('ovImg',  ad.images && (ad.images.large || ad.images.small));
    }

    async function adminSaveCardOverride(apiCardId, reportId) {
      if (!currentUser?.is_admin) return;
      var st = document.getElementById('ovStatus');
      function readVal(id) { var el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }
      var payload = {
        api_card_id:    apiCardId,
        card_name:      readVal('ovName')  || null,
        set_name:       readVal('ovSet')   || null,
        set_code:       readVal('ovCode')  || null,
        card_number:    readVal('ovNum')   || null,
        rarity:         readVal('ovRare')  || null,
        card_image_url: readVal('ovImg')   || null,
        notes:          readVal('ovNotes') || null,
        updated_at:     new Date().toISOString(),
        updated_by:     currentUser.id
      };
      if (st) _setProcessingText(st, 'Saving override…');
      var res = await sb.from('card_overrides').upsert(payload, { onConflict: 'api_card_id' });
      if (res.error) {
        var msg = (res.error.message || '').toLowerCase();
        if (msg.indexOf('relation') !== -1 || msg.indexOf('does not exist') !== -1) {
          printAdminCardSQL();
          if (st) _setProcessingText(st, 'Migration required — see console for SQL');
          return;
        }
        if (st) _setProcessingText(st, 'Save failed: ' + res.error.message);
        return;
      }

      // If a report was attached, mark it resolved
      if (reportId) {
        await sb.from('card_reports').update({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolved_by: currentUser.id
        }).eq('id', reportId);
      }
      // Refresh in-memory override cache so the new values flow to all
      // subsequent add-card operations in this session.
      try { await _loadCardOverrides(); } catch(_) {}

      if (st) _setProcessingText(st, 'Saved');
      showToast('Override saved' + (reportId ? ' · report resolved' : ''));
      var existing = document.getElementById('adminOverrideEditor');
      if (existing) existing.remove();
      adminLoadCardReports(reportId ? 'open' : 'open');
    }

    async function adminDeleteCardOverride(apiCardId) {
      if (!currentUser?.is_admin) return;
      if (!confirm('Delete the override for ' + apiCardId + '? Catalog data will be used as-is again.')) return;
      var res = await sb.from('card_overrides').delete().eq('api_card_id', apiCardId);
      if (res.error) { showToast('Delete failed: ' + res.error.message); return; }
      showToast('Override deleted');
      var existing = document.getElementById('adminOverrideEditor');
      if (existing) existing.remove();
    }
    // ── End Admin Card Editor ─────────────────────────────────────────────

// ── Tabbed admin dashboard ───────────────────────────────────────────
// Mirrors the account-page tab pattern: one .admin-panel per tab, shown
// via .active. Re-renders the Overview metrics each time it's opened.
// ── Content reports (abuse/UGC) admin queue — App Store Guideline 1.2 ────
async function loadContentReports(){
  var box = document.getElementById('adminContentReportsList');
  var cntEl = document.getElementById('adminContentReportsCount');
  if (!box) return;
  var esc = function(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  box.innerHTML = '<div style="color:var(--muted);font-size:.8rem">Loading…</div>';
  var res = await sb.from('content_reports').select('*').order('created_at', { ascending: false }).limit(80);
  if (res.error) { box.innerHTML = '<div style="color:var(--red);font-size:.8rem">Could not load reports (is migration_content_reports.sql applied?).</div>'; return; }
  var rows = res.data || [];
  var open = rows.filter(function(r){ return r.status === 'open'; });
  if (cntEl) cntEl.textContent = '(' + open.length + ' open)';
  if (!rows.length) { box.innerHTML = '<div style="color:var(--muted);font-size:.8rem">No reports yet.</div>'; return; }
  box.innerHTML = rows.map(function(r){
    var badge = r.status === 'open' ? 'var(--yellow)' : r.status === 'actioned' ? 'var(--red)' : 'var(--muted)';
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;background:var(--surface2)">'
      + '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px">'
      +   '<span style="font-size:.72rem;color:var(--text);text-transform:uppercase;letter-spacing:.06em">' + esc(r.target_type) + (r.target_label ? ' · ' + esc(r.target_label) : '') + '</span>'
      +   '<span style="font-size:.62rem;color:' + badge + ';text-transform:uppercase">' + esc(r.status) + '</span>'
      + '</div>'
      + '<div style="font-size:.74rem;color:var(--accent);margin-bottom:4px">' + esc(r.reason) + '</div>'
      + (r.details ? '<div style="font-size:.72rem;color:var(--muted);margin-bottom:6px;line-height:1.5">' + esc(r.details) + '</div>' : '')
      + '<div style="font-size:.6rem;color:var(--muted);margin-bottom:8px">target: ' + esc(r.target_id) + ' · ' + new Date(r.created_at).toLocaleString() + '</div>'
      + (r.status === 'open'
          ? '<div style="display:flex;gap:6px;flex-wrap:wrap">'
            + '<button onclick="_setContentReportStatus(\'' + r.id + '\',\'actioned\')" style="border:1px solid var(--red);background:transparent;color:var(--red);font-family:\'Space Mono\',monospace;font-size:.66rem;padding:4px 10px;cursor:pointer">Mark actioned</button>'
            + '<button onclick="_setContentReportStatus(\'' + r.id + '\',\'dismissed\')" style="border:1px solid var(--border);background:transparent;color:var(--muted);font-family:\'Space Mono\',monospace;font-size:.66rem;padding:4px 10px;cursor:pointer">Dismiss</button>'
            + '</div>'
          : '')
      + '</div>';
  }).join('');
}
async function _setContentReportStatus(id, status){
  try {
    var res = await sb.from('content_reports').update({ status: status, reviewed_at: new Date().toISOString() }).eq('id', id);
    if (res.error) throw res.error;
  } catch(e){ console.error('[content report update]', e); }
  loadContentReports();
}
window.loadContentReports = loadContentReports;
window._setContentReportStatus = _setContentReportStatus;

function switchAdminTab(tab){
  try{
    var root = document.getElementById('adminPage');
    if (!root) return;
    root.querySelectorAll('.admin-tab').forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-tab') === tab); });
    root.querySelectorAll('.admin-panel').forEach(function(p){ p.classList.toggle('active', p.id === tab); });
    if (tab === 'adminOverview' && typeof renderAdminOverview === 'function') renderAdminOverview();
    if (tab === 'adminModeration' && typeof loadContentReports === 'function') loadContentReports();
    if (tab === 'adminGiveaways' && typeof renderAdminGiveaways === 'function') renderAdminGiveaways();
  } catch(e){ console.warn('[admin] switchAdminTab', e); }
}

// ── Giveaways admin ────────────────────────────────────────────────────────
// Create/open/close/draw drawings and auto-enter paying subscribers. Entry
// totals come from giveaway_stats (admin-gated RPC); regular users never have
// a path to the pool size. Draw calls giveaway_draw_winners (seeded weighted).
async function renderAdminGiveaways(){
  var box = document.getElementById('adminGiveawaysList');
  if (!box) return;
  box.innerHTML = '<div style="font-size:.7rem;color:var(--muted)">Loading…</div>';
  try {
    var res = await sb.from('giveaways')
      .select('id,name,prize,num_winners,status,opens_at,closes_at,drawn_at,created_at')
      .order('created_at', { ascending: false });
    if (res.error) throw res.error;
    var rows = res.data || [];
    if (!rows.length) {
      box.innerHTML = '<div style="font-size:.72rem;color:var(--muted)">No giveaways yet. Create one above.</div>';
      return;
    }
    box.innerHTML = rows.map(_gaCardHtml).join('');
    rows.forEach(function(g){ _gaLoadStats(g.id); if (g.status === 'drawn') _gaLoadWinners(g.id); });
  } catch(e){
    box.innerHTML = '<div style="font-size:.72rem;color:var(--red)">Error: ' + _escHtml(e.message || String(e)) + '</div>';
  }
}

function _gaStatusColor(s){
  return s === 'open' ? 'var(--green)' : s === 'drawn' ? 'var(--accent)'
       : s === 'closed' ? 'var(--yellow)' : s === 'scheduled' ? 'var(--copper)'
       : 'var(--muted)';
}

function _gaBtn(label, onclick, color){
  return '<button type="button" onclick="' + onclick + '" style="font-family:\'Space Mono\',monospace;'
    + 'font-size:.62rem;letter-spacing:.04em;padding:6px 12px;border:1px solid ' + color + ';'
    + 'background:transparent;color:' + color + ';cursor:pointer">' + label + '</button>';
}

function _gaCardHtml(g){
  var sc = _gaStatusColor(g.status);
  var name = _escHtml(g.name || '');
  var prize = _escHtml(g.prize || '');
  var opens = g.opens_at ? _escHtml(new Date(g.opens_at).toLocaleString()) : '';
  var closes = g.closes_at ? _escHtml(new Date(g.closes_at).toLocaleString()) : '';
  var dupBtn = _gaBtn('Review duplicates', "adminReviewDupes('" + g.id + "')", 'var(--yellow)');
  var prizeBtn = _gaBtn('Edit prizes', "adminEditPrizes('" + g.id + "')", 'var(--copper)');
  var mediaBtn = _gaBtn('Edit media', "adminEditMedia('" + g.id + "')", 'var(--copper)');
  var liveBtn = _gaBtn('Live draw (stream)', "adminLiveDraw('" + g.id + "')", 'var(--accent)');
  var actions = '';
  if (g.status === 'draft') {
    actions = _gaBtn('Announce (starting soon)', "adminSetGiveawayStatus('" + g.id + "','scheduled')", 'var(--copper)')
            + _gaBtn('Open &amp; enter subscribers', "adminOpenGiveaway('" + g.id + "')", 'var(--green)');
  } else if (g.status === 'scheduled') {
    actions = _gaBtn('Open &amp; enter subscribers', "adminOpenGiveaway('" + g.id + "')", 'var(--green)')
            + _gaBtn('Back to draft', "adminSetGiveawayStatus('" + g.id + "','draft')", 'var(--muted)');
  } else if (g.status === 'open') {
    actions = _gaBtn('Re-grant subscribers', "adminGrantSubs('" + g.id + "')", 'var(--copper)')
            + dupBtn
            + _gaBtn('Close', "adminSetGiveawayStatus('" + g.id + "','closed')", 'var(--yellow)')
            + _gaBtn('Draw winners', "adminDrawGiveaway('" + g.id + "')", 'var(--accent)');
  } else if (g.status === 'closed') {
    actions = _gaBtn('Re-open', "adminSetGiveawayStatus('" + g.id + "','open')", 'var(--muted)')
            + dupBtn
            + _gaBtn('Draw winners', "adminDrawGiveaway('" + g.id + "')", 'var(--accent)');
  } else {
    actions = '<span style="font-size:.6rem;color:var(--muted);align-self:center;margin-right:4px">Drawn'
      + (g.drawn_at ? ' ' + _escHtml(new Date(g.drawn_at).toLocaleDateString()) : '') + '</span>'
      + _gaBtn('Email winners', "adminEmailWinners('" + g.id + "')", 'var(--copper)');
  }
  if (g.status !== 'drawn') actions += prizeBtn;                 // edit per-rank prizes
  actions += mediaBtn;                                          // photo/video, any status
  if (g.status === 'open' || g.status === 'closed' || g.status === 'drawn') actions += liveBtn;
  return '<div style="border:1px solid var(--border);background:var(--surface);padding:14px 16px;margin-bottom:12px">'
    + '<div id="gaPrizeEdit-' + g.id + '"></div>'
    + '<div id="gaMediaEdit-' + g.id + '"></div>'
    + '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">'
    +   '<div style="font-size:.82rem;color:var(--text);font-weight:700">' + (prize || name || 'Giveaway') + '</div>'
    +   '<div style="font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;color:' + sc + '">' + _escHtml(g.status) + '</div>'
    + '</div>'
    + (name && prize ? '<div style="font-size:.62rem;color:var(--muted);margin-top:2px">' + name + '</div>' : '')
    + '<div style="font-size:.62rem;color:var(--muted);margin-top:4px">Winners: ' + (g.num_winners || 1)
        + (opens ? ' &middot; Starts ' + opens : '')
        + (closes ? ' &middot; Closes ' + closes : '') + '</div>'
    + '<div id="gaStats-' + g.id + '" style="font-family:\'Orbitron\',monospace;font-size:.7rem;color:var(--accent);margin-top:8px">&mdash;</div>'
    + '<div id="gaWinners-' + g.id + '"></div>'
    + '<div id="gaDupes-' + g.id + '"></div>'
    + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">' + actions + '</div>'
    + '</div>';
}

async function _gaLoadStats(id){
  var el = document.getElementById('gaStats-' + id);
  if (!el) return;
  try {
    var r = await sb.rpc('giveaway_stats', { p_giveaway_id: id });
    var row = (r && r.data && r.data[0]) || null;
    if (r.error || !row) { el.textContent = '—'; return; }
    var ent = row.entrants || 0;
    el.innerHTML = (row.total_entries || 0) + ' entries '
      + '<span style="color:var(--muted);font-size:.6rem">from ' + ent + ' entrant' + (ent === 1 ? '' : 's') + '</span>';
  } catch(_) { el.textContent = '—'; }
}

async function _gaLoadWinners(id){
  var el = document.getElementById('gaWinners-' + id);
  if (!el) return;
  try {
    var r = await sb.from('giveaway_winners')
      .select('prize_rank,user_id,email,entries_held')
      .eq('giveaway_id', id).order('prize_rank', { ascending: true });
    if (r.error) return;
    var ws = r.data || [];
    if (!ws.length) return;
    el.innerHTML = '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">'
      + '<div style="font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:var(--copper);margin-bottom:4px">Winners</div>'
      + ws.map(function(w){
          var who = _escHtml(w.user_id || w.email || 'unknown');
          return '<div style="font-size:.62rem;color:var(--text)">#' + w.prize_rank
            + ' &mdash; <code style="color:var(--accent)">' + who + '</code> '
            + '<span style="color:var(--muted)">(' + (w.entries_held || 0) + ' entries)</span></div>';
        }).join('')
      + '</div>';
  } catch(_){}
}

// ── Shared-IP duplicate review (admin) ───────────────────────────────────────
// Reads giveaway_ip_clusters (admin-gated RPC) and lets the admin disqualify
// suspected sock accounts BEFORE the draw. NOT automatic: carriers/households
// legitimately share IPs. Paying subscribers are protected server-side, so the
// disqualify button is hidden for them and the RPC refuses them anyway.
async function adminReviewDupes(id){
  var box = document.getElementById('gaDupes-' + id);
  if (!box) return;
  box.innerHTML = '<div style="font-size:.62rem;color:var(--muted);margin-top:8px">Scanning shared IPs…</div>';
  try {
    var r = await sb.rpc('giveaway_ip_clusters', { p_giveaway_id: id });
    if (r.error) throw r.error;
    _gaRenderClusters(id, r.data || []);
  } catch(e){
    box.innerHTML = '<div style="font-size:.62rem;color:var(--red);margin-top:8px">Dup scan failed: ' + _escHtml(e.message || String(e)) + '</div>';
  }
}

function _gaRenderClusters(id, rows){
  var box = document.getElementById('gaDupes-' + id);
  if (!box) return;
  if (!rows.length){
    box.innerHTML = '<div style="font-size:.62rem;color:var(--green);margin-top:8px;border-top:1px solid var(--border);padding-top:8px">No shared-IP clusters. Nothing to review.</div>';
    return;
  }
  var groups = {};
  rows.forEach(function(row){ (groups[row.cluster_key] = groups[row.cluster_key] || []).push(row); });
  var html = '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">'
    + '<div style="font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:var(--yellow);margin-bottom:6px">Shared-IP clusters &mdash; review before drawing</div>'
    + '<div style="font-size:.56rem;color:var(--muted);margin-bottom:8px;line-height:1.5">Carriers &amp; households share IPs, so these are NOT auto-removed. Subscribers are protected (they paid). Disqualify only accounts you judge to be duplicates &mdash; the highest-entry one is usually the keeper.</div>';
  Object.keys(groups).forEach(function(k){
    var grp = groups[k];
    var hint = _escHtml(grp[0].ip_hint || '');
    html += '<div style="border:1px solid var(--border);background:var(--surface2);padding:8px 10px;margin-bottom:8px">'
      + '<div style="font-size:.56rem;color:var(--muted);margin-bottom:6px">IP ' + hint + ' &middot; ' + grp.length + ' accounts</div>';
    grp.forEach(function(row, idx){
      var uname = _escHtml(row.username || row.user_id || 'unknown');
      var tag = '';
      if (row.is_subscriber) tag = '<span style="color:var(--green);font-size:.54rem">protected (subscriber)</span>';
      else if (idx === 0)    tag = '<span style="color:var(--copper);font-size:.54rem">highest &mdash; keeper</span>';
      var btn = '';
      if (!row.is_subscriber) {
        btn = row.is_disqualified
          ? _gaBtn('Requalify', "adminRequalify('" + id + "','" + row.user_id + "')", 'var(--muted)')
          : _gaBtn('Disqualify', "adminDisqualify('" + id + "','" + row.user_id + "')", 'var(--red)');
      }
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 0' + (row.is_disqualified ? ';opacity:.5' : '') + '">'
        + '<div style="font-size:.6rem;color:var(--text)">' + uname
        +   ' <span style="color:var(--muted)">(' + (row.total_entries || 0) + ' entries)</span> ' + tag
        +   (row.is_disqualified ? ' <span style="color:var(--red);font-size:.54rem">disqualified</span>' : '')
        + '</div><div>' + btn + '</div></div>';
    });
    html += '</div>';
  });
  html += '</div>';
  box.innerHTML = html;
}

async function adminDisqualify(id, userId){
  try {
    var r = await sb.rpc('giveaway_disqualify', { p_giveaway_id: id, p_user_ids: [userId], p_reason: 'shared-IP duplicate' });
    if (r.error) throw r.error;
    showToast(r.data ? 'Disqualified.' : 'Not disqualified (subscribers are protected).');
    adminReviewDupes(id);
  } catch(e){ showToast('Failed: ' + (e.message || e)); }
}

async function adminRequalify(id, userId){
  try {
    var r = await sb.rpc('giveaway_requalify', { p_giveaway_id: id, p_user_ids: [userId] });
    if (r.error) throw r.error;
    showToast('Requalified.');
    adminReviewDupes(id);
  } catch(e){ showToast('Failed: ' + (e.message || e)); }
}

function _gaAttr(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Resolve a prize_rank to its tier label (mirrors the server resolver).
function _gaTierLabel(g, rank){
  var tiers = (g && Array.isArray(g.prize_tiers)) ? g.prize_tiers : [];
  for (var i = 0; i < tiers.length; i++){
    var t = tiers[i]; if (!t || t.label == null) continue;
    var from = parseInt(t.from, 10);
    var to = (t.to == null || t.to === '') ? Infinity : parseInt(t.to, 10);
    if (!isNaN(from) && rank >= from && rank <= to) return String(t.label);
  }
  return (g && g.prize) || 'Prize';
}

// ── Media upload (photo + video) ─────────────────────────────────────────────
// Uploads to the public giveaway-media bucket (admin-only write) and returns
// the public URL to store on the giveaway row.
async function _gaUploadMedia(file){
  var ext = (String(file.name || '').split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  var path = 'gm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + (ext || 'bin');
  var up = await sb.storage.from('giveaway-media').upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type || undefined });
  if (up.error) throw up.error;
  var pub = sb.storage.from('giveaway-media').getPublicUrl(path);
  return (pub && pub.data && pub.data.publicUrl) || '';
}

async function adminEditMedia(id){
  var box = document.getElementById('gaMediaEdit-' + id);
  if (!box) return;
  if (box.getAttribute('data-open') === '1'){ box.innerHTML = ''; box.removeAttribute('data-open'); return; }
  box.setAttribute('data-open', '1');
  box.innerHTML = '<div style="font-size:.62rem;color:var(--muted);padding:8px 0">Loading media…</div>';
  var img = '', vid = '';
  try {
    var r = await sb.from('giveaways').select('image_url,video_url').eq('id', id).maybeSingle();
    if (r.data){ img = r.data.image_url || ''; vid = r.data.video_url || ''; }
  } catch(_){}
  var preview = '';
  if (img) preview += '<div style="margin-bottom:10px"><img src="' + _gaAttr(img) + '" alt="" style="max-height:120px;max-width:100%;border:1px solid var(--border)"><br>'
    + '<button type="button" onclick="adminClearMedia(\'' + id + '\',\'image\')" style="font-size:.56rem;color:var(--red);background:none;border:none;cursor:pointer;padding:3px 0">Remove photo</button></div>';
  if (vid) preview += '<div style="margin-bottom:10px"><video src="' + _gaAttr(vid) + '" controls style="max-height:150px;max-width:100%;border:1px solid var(--border)"></video><br>'
    + '<button type="button" onclick="adminClearMedia(\'' + id + '\',\'video\')" style="font-size:.56rem;color:var(--red);background:none;border:none;cursor:pointer;padding:3px 0">Remove video</button></div>';
  box.innerHTML = '<div style="border:1px solid var(--copper-dim);background:var(--copper-glow);padding:10px 12px;margin-bottom:10px">'
    + '<div style="font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:var(--copper);margin-bottom:8px">Media (photo + video)</div>'
    + preview
    + '<label style="display:block;font-size:.56rem;color:var(--muted);margin-bottom:3px">' + (img ? 'Replace' : 'Add') + ' photo</label>'
    + '<input type="file" id="gaEM-img-' + id + '" accept="image/*" style="font-family:\'Space Mono\',monospace;font-size:.66rem;color:var(--muted);margin-bottom:10px;display:block">'
    + '<label style="display:block;font-size:.56rem;color:var(--muted);margin-bottom:3px">' + (vid ? 'Replace' : 'Add') + ' video (max 100 MB)</label>'
    + '<input type="file" id="gaEM-vid-' + id + '" accept="video/*" style="font-family:\'Space Mono\',monospace;font-size:.66rem;color:var(--muted);margin-bottom:10px;display:block">'
    + '<div style="display:flex;gap:6px">'
    +   _gaBtn('Save media', "adminSaveMedia('" + id + "')", 'var(--green)')
    +   _gaBtn('Close', "adminEditMedia('" + id + "')", 'var(--muted)')
    + '</div></div>';
}

async function adminSaveMedia(id){
  var imgEl = document.getElementById('gaEM-img-' + id);
  var vidEl = document.getElementById('gaEM-vid-' + id);
  var patch = {};
  try {
    if (imgEl && imgEl.files && imgEl.files[0]){ showToast('Uploading photo…'); patch.image_url = await _gaUploadMedia(imgEl.files[0]); }
    if (vidEl && vidEl.files && vidEl.files[0]){ showToast('Uploading video…'); patch.video_url = await _gaUploadMedia(vidEl.files[0]); }
  } catch(e){ showToast('Upload failed: ' + (e.message || e)); return; }
  if (!Object.keys(patch).length){ showToast('Pick a file first.'); return; }
  patch.updated_at = new Date().toISOString();
  try {
    var r = await sb.from('giveaways').update(patch).eq('id', id);
    if (r.error) throw r.error;
    showToast('Media saved');
    var box = document.getElementById('gaMediaEdit-' + id); if (box){ box.innerHTML = ''; box.removeAttribute('data-open'); }
  } catch(e){ showToast('Save failed: ' + (e.message || e)); }
}

async function adminClearMedia(id, kind){
  var patch = {}; patch[kind === 'video' ? 'video_url' : 'image_url'] = null;
  patch.updated_at = new Date().toISOString();
  try {
    var r = await sb.from('giveaways').update(patch).eq('id', id);
    if (r.error) throw r.error;
    showToast('Removed');
    var box = document.getElementById('gaMediaEdit-' + id); if (box){ box.innerHTML = ''; box.removeAttribute('data-open'); }
    adminEditMedia(id);
  } catch(e){ showToast('Failed: ' + (e.message || e)); }
}

// ── Edit prizes by rank (inline on the card) ─────────────────────────────────
async function adminEditPrizes(id){
  var box = document.getElementById('gaPrizeEdit-' + id);
  if (!box) return;
  if (box.getAttribute('data-open') === '1'){ box.innerHTML = ''; box.removeAttribute('data-open'); return; }
  box.setAttribute('data-open', '1');
  box.innerHTML = '<div style="font-size:.62rem;color:var(--muted);padding:8px 0">Loading prizes…</div>';
  var grand = '', rest = '';
  try {
    var r = await sb.from('giveaways').select('prize_tiers,prize').eq('id', id).maybeSingle();
    var tiers = (r.data && Array.isArray(r.data.prize_tiers)) ? r.data.prize_tiers : [];
    tiers.forEach(function(t){
      var from = parseInt(t.from, 10);
      if (from === 1) grand = t.label || '';
      else if (from >= 2) rest = t.label || '';
    });
    if (!grand) grand = (r.data && r.data.prize) || '';
  } catch(_){}
  box.innerHTML = '<div style="border:1px solid var(--copper-dim);background:var(--copper-glow);padding:10px 12px;margin-bottom:10px">'
    + '<div style="font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:var(--copper);margin-bottom:8px">Prizes by rank (used in the winner email)</div>'
    + '<label style="display:block;font-size:.56rem;color:var(--muted);margin-bottom:3px">Rank 1 — grand prize</label>'
    + '<input id="gaEP-grand-' + id + '" value="' + _gaAttr(grand) + '" style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);padding:7px 10px;font-family:\'Space Mono\',monospace;font-size:.72rem;color:var(--text);outline:none;margin-bottom:8px">'
    + '<label style="display:block;font-size:.56rem;color:var(--muted);margin-bottom:3px">Ranks 2+ — everyone else (TBD until the pull video)</label>'
    + '<input id="gaEP-rest-' + id + '" value="' + _gaAttr(rest) + '" style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);padding:7px 10px;font-family:\'Space Mono\',monospace;font-size:.72rem;color:var(--text);outline:none;margin-bottom:10px">'
    + '<div style="display:flex;gap:6px">'
    +   _gaBtn('Save prizes', "adminSavePrizes('" + id + "')", 'var(--green)')
    +   _gaBtn('Cancel', "adminEditPrizes('" + id + "')", 'var(--muted)')
    + '</div></div>';
}

async function adminSavePrizes(id){
  var g = ((document.getElementById('gaEP-grand-' + id) || {}).value || '').trim();
  var rt = ((document.getElementById('gaEP-rest-' + id) || {}).value || '').trim();
  var tiers = [{ from: 1, to: 1, label: g || 'Grand prize' }];
  if (rt) tiers.push({ from: 2, to: null, label: rt });
  try {
    var r = await sb.from('giveaways').update({ prize_tiers: tiers, updated_at: new Date().toISOString() }).eq('id', id);
    if (r.error) throw r.error;
    showToast('Prizes saved');
    var box = document.getElementById('gaPrizeEdit-' + id);
    if (box){ box.innerHTML = ''; box.removeAttribute('data-open'); }
  } catch(e){ showToast('Save failed: ' + (e.message || e)); }
}

// ── Live-draw spinner (stream) ───────────────────────────────────────────────
// A reel that spins through the (weighted) entrant pool and lands on the REAL
// winner. The winner is chosen by the authoritative seeded draw
// (giveaway_draw_winners) — the reel is theatre rigged to the recorded result,
// so it stays auditable/reproducible. Labels are public usernames.
function _gaInjectDrawStyles(){
  if (document.getElementById('gaLdStyles')) return;
  var s = document.createElement('style'); s.id = 'gaLdStyles';
  s.textContent =
    '.ga-ld-overlay{position:fixed;inset:0;z-index:99999;background:rgba(8,6,4,.93);display:flex;align-items:center;justify-content:center;padding:20px}'
    + '.ga-ld-card{position:relative;width:100%;max-width:720px;background:var(--surface);border:1px solid var(--copper);box-shadow:0 0 44px rgba(184,115,51,.25);padding:28px 24px 22px;text-align:center;font-family:\'Space Mono\',monospace}'
    + '.ga-ld-close{position:absolute;top:8px;right:14px;background:none;border:none;color:var(--muted);font-size:1.4rem;cursor:pointer;line-height:1}'
    + '.ga-ld-title{font-family:\'Orbitron\',monospace;font-size:1.05rem;font-weight:800;color:var(--text);margin-bottom:6px;line-height:1.3}'
    + '.ga-ld-rank{font-size:.7rem;color:var(--copper);letter-spacing:.05em;margin-bottom:16px;min-height:1.1em}'
    + '.ga-ld-reel-wrap{position:relative;overflow:hidden;border:1px solid var(--border);background:var(--bg);height:276px;margin-bottom:14px}'
    + '.ga-ld-marker{position:absolute;left:0;right:0;top:50%;height:46px;transform:translateY(-23px);border-top:2px solid var(--accent);border-bottom:2px solid var(--accent);box-shadow:inset 0 0 16px rgba(var(--accent-rgb),.28);z-index:2;pointer-events:none}'
    + '.ga-ld-reel{position:absolute;top:0;left:0;right:0;display:flex;flex-direction:column;will-change:transform}'
    + '.ga-ld-tile{height:44px;margin-bottom:2px;display:flex;align-items:center;justify-content:center;background:var(--surface2);border:1px solid var(--border);color:var(--muted);font-size:.82rem;overflow:hidden;padding:0 10px}'
    + '.ga-ld-arm{font-family:\'Orbitron\',monospace;font-size:.66rem;font-weight:800;letter-spacing:.1em;padding:12px 20px;border:1px solid var(--copper);background:transparent;color:var(--copper);cursor:pointer}'
    + '.ga-ld-tile.ga-ld-win{color:var(--text);border-color:var(--copper)}'
    + '.ga-ld-tile.ga-ld-landed{color:var(--accent);border-color:var(--accent);background:rgba(var(--accent-rgb),.14);box-shadow:0 0 18px rgba(var(--accent-rgb),.45)}'
    + '.ga-ld-winner{opacity:0;transition:opacity .4s;margin-bottom:14px}'
    + '.ga-ld-winner.show{opacity:1}'
    + '.ga-ld-win-rank{font-family:\'Orbitron\',monospace;font-size:.58rem;letter-spacing:.14em;color:var(--gold);text-transform:uppercase;margin-bottom:4px}'
    + '.ga-ld-win-name{font-family:\'Orbitron\',monospace;font-size:1.5rem;font-weight:800;color:var(--accent);word-break:break-word}'
    + '.ga-ld-win-prize{font-size:.78rem;color:var(--text);margin-top:4px}'
    + '.ga-ld-win-entries{font-size:.62rem;color:var(--muted);margin-top:2px}'
    + '.ga-ld-controls{display:flex;justify-content:center;gap:10px;margin-bottom:10px}'
    + '.ga-ld-btn{font-family:\'Orbitron\',monospace;font-size:.78rem;font-weight:800;letter-spacing:.08em;padding:12px 26px;border:1px solid var(--muted);background:transparent;color:var(--text);cursor:pointer}'
    + '.ga-ld-btn.primary{border-color:var(--accent);color:var(--accent)}'
    + '.ga-ld-btn[disabled]{opacity:.5;cursor:default}'
    + '.ga-ld-note{font-size:.58rem;color:var(--muted);line-height:1.5}'
    + '.ga-ld-prizesel{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;margin-bottom:12px}'
    + '.ga-ld-prizesel label{font-family:\'Orbitron\',monospace;font-size:.56rem;letter-spacing:.1em;text-transform:uppercase;color:var(--copper)}'
    + '.ga-ld-prizesel select,.ga-ld-prizesel input{font-family:\'Space Mono\',monospace;font-size:.72rem;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:7px 10px;max-width:340px}'
    + '.ga-ld-wtable-wrap{margin-top:16px;border-top:1px solid var(--border);padding-top:12px;text-align:left;max-height:220px;overflow:auto}'
    + '.ga-ld-wtable-title{font-family:\'Orbitron\',monospace;font-size:.6rem;letter-spacing:.12em;text-transform:uppercase;color:var(--copper);margin-bottom:8px}'
    + '.ga-ld-wtable{width:100%;border-collapse:collapse;font-family:\'Space Mono\',monospace}'
    + '.ga-ld-wtable th{font-size:.52rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);text-align:left;padding:4px 8px;border-bottom:1px solid var(--copper-dim)}'
    + '.ga-ld-wtable td{font-size:.72rem;color:var(--text);padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}'
    + '.ga-ld-wtable td.rk{color:var(--accent);font-family:\'Orbitron\',monospace;font-weight:800;width:30px}'
    + '.ga-ld-wtable td.pz{color:var(--muted);font-size:.64rem}';
  document.head.appendChild(s);
}

function _gaWinnerToObj(w){
  var key = w.user_id ? String(w.user_id) : ('email:' + (w.email || ''));
  var found = (window._gaLD && window._gaLD.pool || []).find(function(p){ return p.entrant_key === key; });
  return { rank: w.prize_rank, key: key, label: (found && found.label) || (w.email || 'winner'), entries: w.entries_held || 0, prize_label: w.prize_label || null };
}

// ── Prize selection (which prize the current spin is for) ────────────────────
function _gaPrizeOptions(g){
  var tiers = (g && Array.isArray(g.prize_tiers)) ? g.prize_tiers : [];
  var labels = [];
  tiers.forEach(function(t){ if (t && t.label && labels.indexOf(String(t.label)) < 0) labels.push(String(t.label)); });
  if (!labels.length && g && g.prize) labels.push(String(g.prize));
  if (!labels.length) labels.push('Prize');
  return labels;
}
function _gaPrizeSelectorHtml(g){
  var opts = _gaPrizeOptions(g);
  var sel = '<select id="gaLdPrizeSel" onchange="_gaPrizeSelChanged()">';
  opts.forEach(function(lbl){ sel += '<option value="' + _gaAttr(lbl) + '">' + _escHtml(lbl) + '</option>'; });
  sel += '<option value="__custom__">Custom&hellip;</option></select>';
  return '<div class="ga-ld-prizesel">'
    + '<label>Prize for this spin</label>' + sel
    + '<input id="gaLdPrizeCustom" type="text" placeholder="type a specific prize" style="display:none"></div>';
}
function _gaPrizeSelChanged(){
  var sel = document.getElementById('gaLdPrizeSel');
  var cust = document.getElementById('gaLdPrizeCustom');
  if (!sel || !cust) return;
  cust.style.display = (sel.value === '__custom__') ? '' : 'none';
  if (sel.value === '__custom__') { try { cust.focus(); } catch(_){} }
}
function _gaCurrentPrize(fallback){
  var sel = document.getElementById('gaLdPrizeSel');
  if (!sel) return fallback || '';
  if (sel.value === '__custom__'){
    var cust = document.getElementById('gaLdPrizeCustom');
    return (cust && cust.value.trim()) || fallback || '';
  }
  return sel.value || fallback || '';
}
function _gaSetPrizeDefault(rank){
  var st = window._gaLD; if (!st) return;
  var sel = document.getElementById('gaLdPrizeSel'); if (!sel) return;
  var want = _gaTierLabel(st.giveaway || {}, rank);
  for (var i = 0; i < sel.options.length; i++){
    if (sel.options[i].value === want){ sel.selectedIndex = i; _gaPrizeSelChanged(); return; }
  }
}
function _gaAddWinnerRow(w, prize){
  var wrap = document.getElementById('gaLdTableWrap');
  var body = document.getElementById('gaLdTableBody');
  if (!wrap || !body) return;
  wrap.style.display = '';
  var tr = document.createElement('tr');
  tr.innerHTML = '<td class="rk">' + w.rank + '</td><td>' + _escHtml(w.label) + '</td><td class="pz">' + _escHtml(prize || '') + '</td>';
  body.appendChild(tr);
}

async function adminLiveDraw(id){
  _gaInjectDrawStyles();
  var ov = document.getElementById('gaLiveDraw');
  if (!ov){ ov = document.createElement('div'); ov.id = 'gaLiveDraw'; document.body.appendChild(ov); }
  ov.className = 'ga-ld-overlay';
  ov.innerHTML = '<div class="ga-ld-card"><div style="color:var(--muted);font-size:.8rem;padding:30px">Loading entrant pool…</div></div>';
  window._gaLD = { id: id, pool: [], winners: [], revealIdx: 0, giveaway: null, drawing: false, armed: false, replay: false };
  try {
    var gi = await sb.from('giveaways').select('id,name,prize,num_winners,status,prize_tiers,closes_at').eq('id', id).maybeSingle();
    if (gi.error) throw gi.error;
    window._gaLD.giveaway = gi.data || {};
    var pr = await sb.rpc('giveaway_entrant_pool', { p_giveaway_id: id });
    if (pr.error) throw pr.error;
    window._gaLD.pool = pr.data || [];
    if (gi.data && gi.data.status === 'drawn'){
      window._gaLD.replay = true;
      var wr = await sb.from('giveaway_winners').select('prize_rank,user_id,email,entries_held,prize_label').eq('giveaway_id', id).order('prize_rank');
      window._gaLD.winners = (wr.data || []).map(_gaWinnerToObj);
    }
    _gaRenderLiveDraw();
  } catch(e){
    ov.innerHTML = '<div class="ga-ld-card"><button class="ga-ld-close" onclick="_gaCloseLiveDraw()">&times;</button>'
      + '<div style="color:var(--red);font-size:.8rem;padding:24px">' + _escHtml(e.message || String(e)) + '</div></div>';
  }
}

function _gaRenderLiveDraw(){
  var ov = document.getElementById('gaLiveDraw');
  var st = window._gaLD; if (!ov || !st) return;
  var g = st.giveaway || {};
  var N = g.num_winners || 1;
  var poolCount = (st.pool || []).length;
  var entriesTotal = (st.pool || []).reduce(function(a, p){ return a + (parseInt(p.weight, 10) || 0); }, 0);
  var drawn = g.status === 'drawn';
  ov.innerHTML = '<div class="ga-ld-card">'
    + '<button class="ga-ld-close" onclick="_gaCloseLiveDraw()">&times;</button>'
    + '<div class="ga-ld-title">' + _escHtml(g.prize || g.name || 'Giveaway') + '</div>'
    + '<div class="ga-ld-rank" id="gaLdRank">' + N + ' prize' + (N === 1 ? '' : 's') + ' &middot; one spin each &middot; ' + poolCount + ' entrants &middot; ' + entriesTotal + ' entries</div>'
    + '<div class="ga-ld-reel-wrap"><div class="ga-ld-marker"></div><div class="ga-ld-reel" id="gaLdReel"></div></div>'
    + '<div class="ga-ld-winner" id="gaLdWinner"></div>'
    + _gaPrizeSelectorHtml(g)
    + '<div class="ga-ld-controls" id="gaLdControls">'
    +   (drawn ? '' : '<button class="ga-ld-arm" id="gaLdArm" onclick="_gaToggleArm()">REHEARSE</button>')
    +   '<button class="ga-ld-btn primary" id="gaLdSpin" onclick="_gaSpin()">' + (drawn ? 'SPIN' : 'SPIN (rehearse)') + '</button>'
    + '</div>'
    + '<div class="ga-ld-note">' + (drawn
        ? 'Already drawn — replaying the recorded winners (reproducible from the stored seed).'
        : 'REHEARSE spins practice names and records nothing. Flip to ARMED to run the official seeded draw — once only.') + '</div>'
    + '<div class="ga-ld-wtable-wrap" id="gaLdTableWrap" style="display:none">'
    +   '<div class="ga-ld-wtable-title">&#9670; Winners</div>'
    +   '<table class="ga-ld-wtable"><thead><tr><th style="width:30px">#</th><th>Winner</th><th>Prize</th></tr></thead><tbody id="gaLdTableBody"></tbody></table>'
    + '</div>'
    + '</div>';
  _gaBuildReel((st.pool[0] && st.pool[0].label) || '—');
  _gaSetPrizeDefault(st.winners.length ? st.winners[st.revealIdx].rank : 1);
}

// The reel's content is the REAL pool expanded one tile per entry (a username
// with 25 entries shows 25 times), shuffled — so the scroll is an honest
// picture of the weighting. Repeats are capped at 50/entrant and the whole
// strip at 600 tiles for performance.
function _gaExpandedPool(){
  var pool = (window._gaLD && window._gaLD.pool) || [];
  var arr = [];
  pool.forEach(function(p){
    var n = Math.max(1, Math.min(parseInt(p.weight, 10) || 1, 50));
    for (var i = 0; i < n; i++) arr.push(p.label);
  });
  if (!arr.length) arr = ['entrant'];
  for (var i = arr.length - 1; i > 0; i--){        // Fisher-Yates shuffle
    var j = Math.floor(Math.random() * (i + 1));
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  while (arr.length < 60) arr = arr.concat(arr);    // enough to scroll
  if (arr.length > 600) arr = arr.slice(0, 600);
  return arr;
}

// Weighted random pick for rehearsal spins (no draw, nothing recorded).
function _gaRandomEntrant(){
  var pool = (window._gaLD && window._gaLD.pool) || [];
  if (!pool.length) return { label: 'entrant', entries: 0 };
  var tot = pool.reduce(function(a, p){ return a + (parseInt(p.weight, 10) || 0); }, 0) || 1;
  var r = Math.random() * tot;
  for (var i = 0; i < pool.length; i++){ r -= (parseInt(pool[i].weight, 10) || 0); if (r <= 0) return { label: pool[i].label, entries: pool[i].weight }; }
  var last = pool[pool.length - 1];
  return { label: last.label, entries: last.weight };
}

var _GA_TH = 46, _GA_LAND_FROM_END = 8;   // tile height (44+2 margin); land N from the end

function _gaBuildReel(winLabel){
  var reel = document.getElementById('gaLdReel');
  if (!reel) return 0;
  var arr = _gaExpandedPool();
  var landing = arr.length - _GA_LAND_FROM_END;
  if (landing < 1) landing = arr.length - 1;
  arr[landing] = winLabel;                 // the tile under the marker is the winner
  var html = '';
  for (var i = 0; i < arr.length; i++){
    html += '<div class="ga-ld-tile' + (i === landing ? ' ga-ld-win' : '') + '">' + _escHtml(arr[i]) + '</div>';
  }
  reel.innerHTML = html;
  reel.style.transition = 'none';
  reel.style.transform = 'translateY(0px)';
  void reel.offsetHeight;                  // force reflow so the next transform animates
  return landing;
}

function _gaAnimateToWinner(landing, onDone){
  var reel = document.getElementById('gaLdReel');
  var wrap = reel && reel.parentElement;
  if (!reel || !wrap){ if (onDone) onDone(); return; }
  var H = wrap.clientHeight;
  var jitter = (Math.random() * 12 - 6);
  var target = (H / 2) - (landing * _GA_TH + _GA_TH / 2) + jitter;
  reel.style.transition = 'transform 5s cubic-bezier(0.12,0.7,0.08,1)';
  requestAnimationFrame(function(){ reel.style.transform = 'translateY(' + target + 'px)'; });
  setTimeout(function(){
    var winTile = reel.querySelector('.ga-ld-win');
    if (winTile) winTile.classList.add('ga-ld-landed');
    if (onDone) onDone();
  }, 5120);
}

function _gaToggleArm(){
  var st = window._gaLD; if (!st) return;
  if (st.giveaway && st.giveaway.status === 'drawn') return;  // replay mode, N/A
  if (st.winners.length){ showToast('Already drawn — mode is locked.'); return; }
  st.armed = !st.armed;
  _gaUpdateArmUI();
}

function _gaUpdateArmUI(){
  var st = window._gaLD; if (!st) return;
  var el = document.getElementById('gaLdArm');
  var spin = document.getElementById('gaLdSpin');
  if (el){
    el.textContent = st.armed ? 'ARMED — LIVE' : 'REHEARSE';
    el.style.borderColor = st.armed ? 'var(--red)' : 'var(--copper)';
    el.style.color       = st.armed ? 'var(--red)' : 'var(--copper)';
  }
  if (spin && !st.winners.length){ spin.textContent = st.armed ? 'SPIN — DRAW LIVE' : 'SPIN (rehearse)'; }
}

async function _gaSpin(){
  var st = window._gaLD; if (!st) return;
  if (st.drawing) return;
  var g = st.giveaway || {};
  var btn = document.getElementById('gaLdSpin');

  // ── REHEARSE: practice spin on a weighted-random entrant; nothing recorded ──
  if (!st.armed && g.status !== 'drawn'){
    var pick = _gaRandomEntrant();
    var rEl = document.getElementById('gaLdRank'); if (rEl) rEl.textContent = 'Rehearsal — nothing recorded';
    var rWin = document.getElementById('gaLdWinner'); if (rWin){ rWin.innerHTML = ''; rWin.classList.remove('show'); }
    if (btn){ btn.textContent = 'Spinning…'; btn.disabled = true; btn.style.opacity = '.5'; }
    var rLand = _gaBuildReel(pick.label);
    _gaAnimateToWinner(rLand, function(){
      if (rWin){
        rWin.innerHTML = '<div class="ga-ld-win-rank" style="color:var(--copper)">&#9670; Rehearsal</div>'
          + '<div class="ga-ld-win-name" style="color:var(--copper)">' + _escHtml(pick.label) + '</div>'
          + '<div class="ga-ld-win-prize">practice spin &mdash; no draw, nothing recorded</div>';
        rWin.classList.add('show');
      }
      if (btn){ btn.textContent = 'SPIN (rehearse)'; btn.disabled = false; btn.style.opacity = ''; }
    });
    return;
  }

  // Run the authoritative draw the first time, if not already drawn.
  if (!st.winners.length){
    st.drawing = true;
    if (btn){ btn.textContent = 'Drawing…'; btn.disabled = true; btn.style.opacity = '.5'; }
    try {
      var r = await sb.rpc('giveaway_draw_winners', { p_giveaway_id: st.id });
      if (r.error) throw r.error;
      st.winners = (r.data || []).map(_gaWinnerToObj);
      if (!st.winners.length) throw new Error('no winners drawn');
    } catch(e){
      st.drawing = false;
      if (btn){ btn.textContent = 'SPIN'; btn.disabled = false; btn.style.opacity = ''; }
      showToast('Draw failed: ' + (e.message || e));
      return;
    }
    st.drawing = false;
  }
  if (st.revealIdx >= st.winners.length) return;
  var w = st.winners[st.revealIdx];
  // Prize for this spin: the admin's selection (fresh draw) or the recorded
  // label (replay), falling back to the rank's tier.
  var chosenPrize = st.replay
    ? (w.prize_label || _gaTierLabel(g, w.rank))
    : _gaCurrentPrize(_gaTierLabel(g, w.rank));
  w.prize = chosenPrize;
  var rankEl = document.getElementById('gaLdRank');
  if (rankEl) rankEl.textContent = 'Prize #' + w.rank + ' of ' + (g.num_winners || st.winners.length) + ' — ' + chosenPrize;
  var winEl = document.getElementById('gaLdWinner');
  if (winEl){ winEl.innerHTML = ''; winEl.classList.remove('show'); }
  if (btn){ btn.textContent = 'Spinning…'; btn.disabled = true; btn.style.opacity = '.5'; }
  var winIdx = _gaBuildReel(w.label);
  _gaAnimateToWinner(winIdx, function(){
    // Persist the announced prize so the winner email matches (fresh draws
    // only; replay just displays what was already recorded).
    if (!st.replay){
      try { sb.from('giveaway_winners').update({ prize_label: chosenPrize }).eq('giveaway_id', st.id).eq('prize_rank', w.rank).then(function(){}, function(){}); } catch(_){}
    }
    if (winEl){
      winEl.innerHTML = '<div class="ga-ld-win-rank">&#9670; Winner — prize #' + w.rank + '</div>'
        + '<div class="ga-ld-win-name">' + _escHtml(w.label) + '</div>'
        + '<div class="ga-ld-win-prize">' + _escHtml(chosenPrize) + '</div>'
        + (w.entries ? '<div class="ga-ld-win-entries">held ' + w.entries + ' entries</div>' : '');
      winEl.classList.add('show');
    }
    _gaAddWinnerRow(w, chosenPrize);
    st.revealIdx++;
    if (st.revealIdx < st.winners.length) _gaSetPrizeDefault(st.winners[st.revealIdx].rank);
    if (!btn) return;
    if (st.revealIdx < st.winners.length){
      btn.textContent = 'SPIN NEXT (#' + st.winners[st.revealIdx].rank + ')';
      btn.disabled = false; btn.style.opacity = '';
    } else {
      // All prizes revealed — offer to email each winner their own prize.
      var ctr = document.getElementById('gaLdControls');
      if (ctr) ctr.innerHTML =
        '<button class="ga-ld-btn primary" onclick="_gaEmailFromDraw()">Email ' + st.winners.length + ' winner' + (st.winners.length === 1 ? '' : 's') + '</button>'
        + '<button class="ga-ld-btn" onclick="_gaCloseLiveDraw()">Done</button>';
    }
  });
}

// Email each winner their own prize (reuses the per-winner send endpoint,
// which resolves each winner's rank -> prize-tier label). adminEmailWinners
// prompts for the $600 tax note and sends one email per winner.
function _gaEmailFromDraw(){
  var st = window._gaLD; if (!st || !st.id) return;
  if (typeof adminEmailWinners === 'function') adminEmailWinners(st.id);
}

function _gaCloseLiveDraw(){
  var ov = document.getElementById('gaLiveDraw');
  if (ov){ ov.className = ''; ov.style.display = 'none'; ov.innerHTML = ''; }
  window._gaLD = null;
  try { renderAdminGiveaways(); } catch(_){}
}

async function adminCreateGiveaway(){
  var name = ((document.getElementById('gaName') || {}).value || '').trim();
  var prize = ((document.getElementById('gaPrize') || {}).value || '').trim();
  var winners = parseInt((document.getElementById('gaWinners') || {}).value, 10) || 1;
  var opensRaw = (document.getElementById('gaOpens') || {}).value || '';
  var closesRaw = (document.getElementById('gaCloses') || {}).value || '';
  if (!name) { showToast('Enter an internal name'); return; }
  if (winners < 1) winners = 1;
  var grand = ((document.getElementById('gaPrizeGrand') || {}).value || '').trim();
  var rest  = ((document.getElementById('gaPrizeRest')  || {}).value || '').trim();
  var payload = { name: name, prize: prize || null, num_winners: winners, status: 'draft' };
  if (opensRaw)  { try { payload.opens_at  = new Date(opensRaw).toISOString();  } catch(_){} }
  if (closesRaw) { try { payload.closes_at = new Date(closesRaw).toISOString(); } catch(_){} }
  // Per-rank prize labels for the winner email: rank 1 = grand (or the banner
  // prize), ranks 2+ = rest (TBD until the pull video). Omit a tier if blank.
  var tiers = [];
  tiers.push({ from: 1, to: 1, label: grand || prize || 'Grand prize' });
  if (rest) tiers.push({ from: 2, to: null, label: rest });
  payload.prize_tiers = tiers;
  // Optional media — upload to the public giveaway-media bucket, store the URLs.
  var _imgEl = document.getElementById('gaImage');
  var _vidEl = document.getElementById('gaVideo');
  var _hasImg = !!(_imgEl && _imgEl.files && _imgEl.files[0]);
  var _hasVid = !!(_vidEl && _vidEl.files && _vidEl.files[0]);
  if (_hasImg || _hasVid) showToast('Uploading media…');
  try { if (_hasImg) payload.image_url = await _gaUploadMedia(_imgEl.files[0]); }
  catch(e){ showToast('Photo upload failed: ' + (e.message || e)); }
  try { if (_hasVid) payload.video_url = await _gaUploadMedia(_vidEl.files[0]); }
  catch(e){ showToast('Video upload failed: ' + (e.message || e)); }
  var _created = false, _degraded = false;
  try {
    var r = await sb.from('giveaways').insert(payload);
    if (r.error) throw r.error;
    _created = true;
  } catch(e){
    // Graceful fallback: if a newer optional column is missing because a
    // migration hasn't run yet, strip those columns and retry so the draft
    // still saves (same schema-fallback pattern as quickAddScannedCard).
    var msg = String((e && e.message) || e);
    if (/prize_tiers|image_url|video_url|schema cache|does not exist/i.test(msg)){
      var p2 = Object.assign({}, payload);
      delete p2.prize_tiers; delete p2.image_url; delete p2.video_url;
      try {
        var r2 = await sb.from('giveaways').insert(p2);
        if (r2.error) throw r2.error;
        _created = true; _degraded = true;
      } catch(e2){ showToast('Create failed: ' + ((e2 && e2.message) || e2)); }
    } else {
      showToast('Create failed: ' + msg);
    }
  }
  if (!_created) return;
  showToast(_degraded ? 'Created (draft) — run the latest migration to enable prize tiers/media.' : 'Giveaway created (draft)');
  var n = document.getElementById('gaName'); if (n) n.value = '';
  var p = document.getElementById('gaPrize'); if (p) p.value = '';
  var o = document.getElementById('gaOpens'); if (o) o.value = '';
  var cl = document.getElementById('gaCloses'); if (cl) cl.value = '';
  var pg = document.getElementById('gaPrizeGrand'); if (pg) pg.value = '';
  var pr = document.getElementById('gaPrizeRest'); if (pr) pr.value = '';
  if (_imgEl) _imgEl.value = '';
  if (_vidEl) _vidEl.value = '';
  renderAdminGiveaways();
}

async function adminSetGiveawayStatus(id, status){
  try {
    var r = await sb.from('giveaways')
      .update({ status: status, updated_at: new Date().toISOString() }).eq('id', id);
    if (r.error) throw r.error;
    showToast('Status → ' + status);
    renderAdminGiveaways();
  } catch(e){ showToast('Update failed: ' + (e.message || e)); }
}

async function adminOpenGiveaway(id){
  try {
    var u = await sb.from('giveaways')
      .update({ status: 'open', opens_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id);
    if (u.error) throw u.error;
    var g = await sb.rpc('giveaway_grant_subscriber_entries', { p_giveaway_id: id });
    if (g.error) throw g.error;
    showToast('Opened — entered ' + (g.data || 0) + ' subscriber(s)');
    renderAdminGiveaways();
  } catch(e){ showToast('Open failed: ' + (e.message || e)); }
}

async function adminGrantSubs(id){
  try {
    var g = await sb.rpc('giveaway_grant_subscriber_entries', { p_giveaway_id: id });
    if (g.error) throw g.error;
    showToast('Entered ' + (g.data || 0) + ' new subscriber(s)');
    _gaLoadStats(id);
  } catch(e){ showToast('Grant failed: ' + (e.message || e)); }
}

async function adminDrawGiveaway(id){
  if (!confirm('Draw winners now? This picks the winner(s) and marks the giveaway drawn. It cannot be undone from here.')) return;
  try {
    var r = await sb.rpc('giveaway_draw_winners', { p_giveaway_id: id });
    if (r.error) throw r.error;
    var ws = r.data || [];
    showToast('Drew ' + ws.length + ' winner' + (ws.length === 1 ? '' : 's'));
    renderAdminGiveaways();
  } catch(e){ showToast('Draw failed: ' + (e.message || e)); }
}

// Email the winner(s) via /api/send-giveaway-winner (admin-gated server side).
async function adminEmailWinners(id){
  if (!confirm('Send the winner email to all winners of this giveaway now?')) return;
  var highValue = confirm('Does any single prize have a value of $600 or more?\n\nOK = yes (adds the W-9 / 1099 tax note to the email)\nCancel = no (omit the tax note)');
  try {
    var sess = await sb.auth.getSession();
    var tok = sess && sess.data && sess.data.session && sess.data.session.access_token;
    var r = await fetch('/api/send-giveaway-winner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
      body: JSON.stringify({ giveaway_id: id, highValue: highValue })
    });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok || !j.ok) {
      showToast('Winner email: sent ' + (j.sent || 0) + ', failed ' + (j.failed || 0) + (j.error ? ' — ' + j.error : ''));
    } else {
      showToast('Winner email sent to ' + (j.sent || 0) + ' winner(s)');
    }
  } catch(e){ showToast('Email send failed: ' + (e.message || e)); }
}

function _ovTile(val, lbl, sub){
  return '<div class="admin-ov-tile"><div class="admin-ov-val">' + val + '</div>' +
         '<div class="admin-ov-lbl">' + lbl + '</div>' +
         (sub ? '<div class="admin-ov-sub">' + sub + '</div>' : '') + '</div>';
}

// ── Price Mismatch Audit ────────────────────────────────────────────────
// Surfaces catalog rows where PriceCharting (catalog.current_value) and
// TCGplayer (card_prices source=tcgplayer) disagree by >= the ratio — the
// signature of a mis-linked PriceCharting product. Client-side join so no
// migration/RPC is needed; bounded so it stays an admin spot-tool.
async function renderAdminPriceMismatch(){
  var box = document.getElementById('adminPriceMismatchList');
  if (!box) return;
  var threshold = Math.max(2, Number((document.getElementById('adminPmThreshold')||{}).value) || 4);
  box.innerHTML = '<div style="font-size:.62rem;color:var(--muted)">Scanning…</div>';
  try {
    // 1) Pull TCGplayer comps (bounded to ~8k rows).
    var tcg = {}, scanned = 0, page = 0, PAGE = 1000;
    while (page < 8) {
      var r = await sb.from('card_prices').select('catalog_id, value, source_url').eq('source','tcgplayer').gt('value', 0).range(page*PAGE, page*PAGE + PAGE - 1);
      if (r.error || !r.data || !r.data.length) break;
      r.data.forEach(function(x){ tcg[x.catalog_id] = { v: Number(x.value), url: x.source_url }; });
      scanned += r.data.length;
      if (r.data.length < PAGE) break;
      page++;
    }
    var ids = Object.keys(tcg);
    if (!ids.length) { box.innerHTML = '<div style="font-size:.62rem;color:var(--muted)">No TCGplayer comps found.</div>'; return; }
    // 2) Pull catalog current_value for those ids (chunked) and compare.
    var rows = [];
    for (var i = 0; i < ids.length; i += 200) {
      var cr = await sb.from('catalog').select('id,name,set_name,card_number,current_value,price_source_url,pricecharting_id,image_url').in('id', ids.slice(i, i + 200));
      if (cr.data) cr.data.forEach(function(c){
        var pc = Number(c.current_value) || 0, t = (tcg[c.id]||{}).v || 0;
        if (pc > 0 && t > 0) {
          var ratio = Math.max(pc, t) / Math.min(pc, t);
          if (ratio >= threshold) rows.push({ c: c, pc: pc, tcg: t, ratio: ratio, tcgUrl: (tcg[c.id]||{}).url });
        }
      });
    }
    rows.sort(function(a, b){ return b.ratio - a.ratio; });
    if (!rows.length) { box.innerHTML = '<div style="font-size:.62rem;color:var(--muted)">No divergences ≥ ' + threshold + '× found (scanned ' + scanned + ' TCGplayer comps).</div>'; return; }
    var top = rows.slice(0, 80);
    box.innerHTML = '<div style="font-size:.58rem;color:var(--muted);margin-bottom:6px">' + rows.length + ' divergent card(s) ≥ ' + threshold + '× · showing ' + top.length + '</div>' + top.map(_pmRowHtml).join('');
  } catch(e) { box.innerHTML = '<div style="font-size:.62rem;color:var(--red)">Scan failed: ' + (e.message || 'error') + '</div>'; }
}
function _pmRowHtml(r){
  var c = r.c;
  var pcUrl = c.price_source_url || (c.pricecharting_id ? 'https://www.pricecharting.com/offers?product=' + encodeURIComponent(c.pricecharting_id) : null);
  var tcgUrl = r.tcgUrl || ('https://www.tcgplayer.com/search/all/product?q=' + encodeURIComponent(c.name || ''));
  if (window.tcgAffiliateUrl) tcgUrl = window.tcgAffiliateUrl(tcgUrl, 'admin-pricemon');
  var rid = 'pm_' + String(c.id).replace(/[^a-z0-9]/gi, '_');
  return '<div id="' + rid + '" style="display:flex;gap:10px;align-items:center;border:1px solid var(--border);background:var(--surface2);padding:8px 10px">'
    + (c.image_url ? '<img src="' + c.image_url + '" loading="lazy" decoding="async" style="width:34px;height:47px;object-fit:contain;flex-shrink:0;background:var(--surface)">' : '')
    + '<div style="flex:1;min-width:0">'
    +   '<div style="font-size:.66rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _escHtml(c.name || '?') + '</div>'
    +   '<div style="font-size:.56rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _escHtml(c.set_name || '') + (c.card_number ? (' #' + c.card_number) : '') + '</div>'
    + '</div>'
    + '<div style="text-align:right;flex-shrink:0;font-family:\'Space Mono\',monospace">'
    +   '<div style="font-size:.6rem"><a href="' + (pcUrl || '#') + '" target="_blank" rel="noopener" style="color:var(--copper);text-decoration:none">PC $' + r.pc.toFixed(2) + ' ↗</a></div>'
    +   '<div style="font-size:.6rem"><a href="' + tcgUrl + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">TCG $' + r.tcg.toFixed(2) + ' ↗</a></div>'
    + '</div>'
    + '<div style="flex-shrink:0;text-align:center;min-width:46px">'
    +   '<div style="font-size:.68rem;font-weight:700;color:var(--red)">' + r.ratio.toFixed(1) + '×</div>'
    +   '<button onclick="adminClearPcLink(\'' + c.id + '\')" style="margin-top:3px;font-size:.54rem;padding:3px 7px;border:1px solid var(--red);background:transparent;color:var(--red);cursor:pointer;font-family:inherit">Clear PC</button>'
    + '</div>'
  + '</div>';
}
async function adminClearPcLink(catalogId){
  if (typeof pbConfirm === 'function') {
    var ok = await pbConfirm('Clear the PriceCharting link + value for this card? The suggested price falls back to TCGplayer until the next enrichment re-matches it.', { confirmText: 'CLEAR', danger: true });
    if (!ok) return;
  }
  try {
    var r = await sb.from('catalog').update({ price_source_url: null, pricecharting_id: null, current_value: null }).eq('id', catalogId).select('id');
    if (r.error) { showToast('Failed: ' + r.error.message); return; }
    var row = document.getElementById('pm_' + String(catalogId).replace(/[^a-z0-9]/gi, '_'));
    if (row) row.style.display = 'none';
    showToast('PC link cleared — re-matches on next sync');
  } catch(e) { showToast('Failed: ' + (e.message || 'error')); }
}

// Real app/site metrics for the Overview tab. All queries are defensive:
// a failed/blocked query renders an em-dash rather than throwing. Money
// fields (orders.platform_fee / orders.amount / shop_sales.total_price)
// are treated as dollar-denominated, matching the Payments page.
async function renderAdminOverview(){
  function $(id){ return document.getElementById(id); }
  function money(n){ return '$' + (Number(n)||0).toLocaleString(undefined, {maximumFractionDigits:0}); }
  function show(v){ return (v===null||v===undefined) ? '—' : v; }
  async function cnt(table, build){
    try{ var q = sb.from(table).select('*', {count:'exact', head:true}); if (build) q = build(q); var r = await q; if (r.error) return null; return r.count || 0; }
    catch(e){ return null; }
  }
  var PRICE = { enthusiast:10, vendor:29, shop:99 };  // current monthly prices; collector retired

  // Users & subscriptions
  var tiers = ['free','enthusiast','vendor','shop'];
  var tc = {};
  for (var i=0;i<tiers.length;i++){
    tc[tiers[i]] = await cnt('profiles', (function(t){ return function(q){ return q.eq('subscription_tier', t); }; })(tiers[i]));
  }
  var totalUsers = await cnt('profiles');
  var since = new Date(Date.now() - 30*86400000).toISOString();
  var new30 = await cnt('profiles', function(q){ return q.gte('created_at', since); });
  // Beta testers are comped (free for the term of their code), so subtract
  // them from the paying counts before computing MRR. public_beta_testers
  // exposes active grants; we look up those users' current tiers.
  var betaPerTier = { enthusiast:0, vendor:0, shop:0 };  // founding→vendor, founding_shop→shop count here by subscription_tier
  var betaTotal = 0;
  try{
    var bt = await sb.from('public_beta_testers').select('user_id');
    var betaIds = (bt.data||[]).map(function(r){ return r.user_id; }).filter(Boolean);
    betaTotal = betaIds.length;
    if (betaIds.length){
      var bp = await sb.from('profiles').select('subscription_tier').in('id', betaIds);
      (bp.data||[]).forEach(function(p){ if (betaPerTier[p.subscription_tier] != null) betaPerTier[p.subscription_tier]++; });
    }
  }catch(e){}
  function _paying(t){ return Math.max(0, (tc[t]||0) - (betaPerTier[t]||0)); }
  var mrr = _paying('enthusiast')*PRICE.enthusiast + _paying('vendor')*PRICE.vendor + _paying('shop')*PRICE.shop;

  // Marketplace revenue (net of Stripe 2.9% + $0.30/txn). GMV is informational.
  var fees=0, gmv=0, ord=0;
  try{
    var o = await sb.from('orders').select('platform_fee,amount,status');
    if (!o.error){
      var paid = (o.data||[]).filter(function(x){ return ['paid','shipped','completed','delivered'].indexOf(x.status) >= 0; });
      ord  = paid.length;
      fees = paid.reduce(function(s,x){ return s + (Number(x.platform_fee)||0); }, 0);
      gmv  = paid.reduce(function(s,x){ return s + (Number(x.amount)||0); }, 0);
    }
  } catch(e){}
  var netFees = fees - gmv*0.029 - ord*0.30;
  var shopVol = 0;
  try{ var ss = await sb.from('shop_sales').select('total_price'); if (!ss.error) shopVol = (ss.data||[]).reduce(function(s,x){ return s + (Number(x.total_price)||0); }, 0); } catch(e){}

  // Content
  var coll = await cnt('collection_items');
  var cat  = await cnt('catalog');
  var active = await cnt('listings', function(q){ return q.eq('status','active'); });

  // Moderation queues
  var disp    = await cnt('orders', function(q){ return q.eq('status','disputed'); });
  var susp    = await cnt('listings', function(q){ return q.eq('status','suspended'); });
  var contrib = await cnt('catalog_image_contributions', function(q){ return q.eq('status','pending'); });
  var reports = await cnt('card_reports', function(q){ return q.eq('status','open'); });
  var creports = await cnt('content_reports', function(q){ return q.eq('status','open'); });

  if ($('ovRevenue')) $('ovRevenue').innerHTML =
      _ovTile(money(mrr), 'Subscription MRR', 'paying subs, excl. beta comps')
    + _ovTile(money(netFees), 'Marketplace fees (net)', 'collected − 2.9% Stripe')
    + _ovTile(money(mrr + (netFees>0?netFees:0)), 'Est. monthly revenue', 'MRR + net fees')
    + _ovTile(money(gmv), 'Marketplace GMV', 'potential — not counted')
    + _ovTile(money(shopVol), 'Shop sales volume', 'potential — not counted');

  if ($('ovUsers')) $('ovUsers').innerHTML =
      _ovTile(show(totalUsers), 'Total users', show(new30) + ' new / 30d')
    + _ovTile(show(tc.enthusiast), 'Enthusiast', '$10/mo')
    + _ovTile(show(tc.vendor), 'Vendor', '$29/mo')
    + _ovTile(show(tc.shop), 'Shop', '$99/mo')
    + _ovTile(show(tc.free), 'Free', 'cannot sell')
    + _ovTile(show(betaTotal), 'Beta (comped)', 'free via code, not in MRR');

  if ($('ovContent')) $('ovContent').innerHTML =
      _ovTile(show(coll), 'Collection items', 'tracked across users')
    + _ovTile(show(cat), 'Catalog cards', '')
    + _ovTile(show(active), 'Active listings', 'on marketplace');

  if ($('ovModeration')) $('ovModeration').innerHTML =
      _ovTile(show(disp), 'Open disputes', '')
    + _ovTile(show(susp), 'Suspended listings', '')
    + _ovTile(show(contrib), 'Pending photo contribs', '')
    + _ovTile(show(reports), 'Open card reports', '')
    + _ovTile(show(creports), 'Open content reports', 'abuse / UGC flags');
}
