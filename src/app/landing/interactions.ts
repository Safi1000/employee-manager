/* ============================================================
   BASTION landing — interactions (shadow-root scoped)
   Adapted verbatim from the original static app.js. Every element
   lookup is scoped to the shadow root instead of `document`, all
   listeners/timers are tracked and torn down on unmount, and in-page
   #anchor clicks are handled manually (a shadow anchor's native hash
   nav can't find the target in the light DOM).
   ============================================================ */

export function initBastion(root: ShadowRoot): () => void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof WindowEventMap>(
    t: Window | Document | Element | ShadowRoot,
    ev: string,
    fn: EventListenerOrEventListenerObject,
    opts?: AddEventListenerOptions,
  ) => {
    t.addEventListener(ev, fn, opts);
    cleanups.push(() => t.removeEventListener(ev, fn, opts));
  };

  /* ---- year ---- */
  const yearEl = root.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---- nav scrolled state + mobile menu ---- */
  const nav = root.getElementById("nav");
  const onScroll = () => { if (nav) nav.classList.toggle("scrolled", window.scrollY > 12); };
  onScroll();
  on(window, "scroll", onScroll, { passive: true });

  const toggle = root.getElementById("navToggle");
  const mobile = root.getElementById("navMobile");
  if (toggle && mobile) {
    on(toggle, "click", () => {
      const open = mobile.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    mobile.querySelectorAll("a").forEach((a) => {
      on(a, "click", () => {
        mobile.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ---- in-page anchor smooth-scroll (shadow-scoped) ---- */
  on(root, "click", (e) => {
    const target = (e.target as HTMLElement)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
    if (!target) return;
    const href = target.getAttribute("href") || "";
    // Bare "#" = placeholder CTAs (Sign up) + the Sign-in link (which the
    // component handles separately). Swallow the default top-jump so these are
    // clean no-ops rather than scrolling the page.
    if (href === "#" || href.length < 2) { e.preventDefault(); return; }
    const el = root.getElementById(href.slice(1));
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  });

  /* ---- reveal on scroll ---- */
  const revealEls = root.querySelectorAll<HTMLElement>(".reveal");
  revealEls.forEach((el) => {
    const d = el.getAttribute("data-d");
    if (d) el.style.setProperty("--d", d);
  });
  if (reduce || !("IntersectionObserver" in window)) {
    revealEls.forEach((el) => el.classList.add("in"));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.14, rootMargin: "0px 0px -8% 0px" });
    revealEls.forEach((el) => io.observe(el));
    cleanups.push(() => io.disconnect());
  }

  /* ---- count-up stats ---- */
  const counters = root.querySelectorAll<HTMLElement>(".count");
  const runCount = (el: HTMLElement) => {
    const to = parseInt(el.getAttribute("data-to") || "", 10) || 0;
    if (reduce) { el.textContent = String(to); return; }
    let start: number | null = null;
    const dur = 1400;
    const step = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(eased * to));
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = String(to);
    };
    requestAnimationFrame(step);
  };
  if ("IntersectionObserver" in window) {
    const cio = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { runCount(en.target as HTMLElement); cio.unobserve(en.target); }
      });
    }, { threshold: 0.6 });
    counters.forEach((c) => cio.observe(c));
    cleanups.push(() => cio.disconnect());
  } else {
    counters.forEach(runCount);
  }

  /* ---- attendance calendar (June, 30 days) ---- */
  const cal = root.getElementById("calGrid");
  if (cal) {
    const leaveDays: Record<number, number> = { 11: 1 };
    const absentDays: Record<number, number> = { 22: 1, 29: 1 };
    const frag = document.createDocumentFragment();
    for (let d = 1; d <= 30; d++) {
      const c = document.createElement("div");
      let cls = "p";
      if (leaveDays[d]) cls = "l";
      else if (absentDays[d]) cls = "a";
      c.className = "cal-cell " + cls;
      c.textContent = String(d);
      frag.appendChild(c);
    }
    cal.appendChild(frag);
  }

  /* ---- modules accordion (mirrors the app's own sidebar, section for section) ----
     Kept deliberately 1:1 with SuperAdminLayout's nav groups so the landing page
     stays a faithful summary of the product. If a screen is added, renamed or
     merged in the sidebar, change it here too. */
  const groups: Array<{ title: string; sub: string; mods: Array<[string, string, string]> }> = [
    {
      title: "Overview",
      sub: "The whole company on one screen.",
      mods: [
        ["DB", "Dashboard", "Live financial overview — balances, receivables, payroll due and the widgets you pick."],
        ["AI", "AI Assistant", "Ask your data in plain language. It reads through a fixed set of read-only tools, never writes."],
      ],
    },
    {
      title: "Clients & Contracts",
      sub: "Who you guard, and the deal you signed.",
      mods: [
        ["CL", "Clients", "The master anchor. Tax profile, remit accounts and ID prefix flow everywhere downstream."],
        ["CT", "Contracts", "Per-category committed headcount and rates, with dated addendums that keep true history."],
        ["IN", "Invoices", "Built from the contract lines and tax profile; tracked from raised to fully paid, exported to PDF."],
      ],
    },
    {
      title: "Workforce",
      sub: "Every guard, their days, and their pay.",
      mods: [
        ["EM", "Employees", "The full guard record — CNIC, verification, documents, salary and lifecycle from hire to final settlement."],
        ["RC", "Recruitment", "Candidate intake and pipeline: applied, screening, interview, offer, hired."],
        ["AT", "Attendance", "A daily board per client-shift: presume present, enter only the exceptions, confirm the shift."],
        ["PR", "Payroll", "Payslips and the run pipeline — draft, review, approve, disburse — in one place."],
        ["PF", "Performance", "KPIs, appraisals, bonus pools and guard bonuses, with an approval gate."],
        ["RV", "Relievers", "Floating guards attributed per day to the client they actually covered."],
      ],
    },
    {
      title: "Operations",
      sub: "Cover the posts, report the day, track the kit.",
      mods: [
        ["DP", "Deployment", "Contracted vs. actually-enrolled headcount per client — every shortfall visible."],
        ["DR", "Daily Reports", "Date-wise per-post client report, generated to a branded PDF."],
        ["IC", "Incidents", "Incidents and client complaints on one record: severity, client, post and named guards."],
        ["AS", "Assets & Issuance", "The asset register plus the weapons and uniform issuance ledger — who holds what."],
      ],
    },
    {
      title: "Finance",
      sub: "Every rupee through your banks and cash box.",
      mods: [
        ["AC", "Accounting Core", "Opening balances feeding the chart of accounts, trial balance and general ledger."],
        ["BK", "Bank & Ledgers", "Receivables, payables, bank accounts with cheques and deposits, and cash custody."],
        ["EX", "Expenses & Advances", "Costs and staff advances by cash, bank, payable or cheque; advances recovered on the next payslip."],
        ["CF", "Cash Flow", "Inflow against outflow, by month, range or all time."],
        ["FR", "Financial Reports", "P&L, partnership position and full printable client statements."],
        ["PC", "Period Close", "Lock a month app-wide so signed-off figures can't shift underneath you."],
        ["TR", "Treasury & Reserves", "Cash cockpit, reserves, regional P&L and inter-region loans."],
      ],
    },
    {
      title: "Profit-Share",
      sub: "What each region earned, and each partner's share.",
      mods: [
        ["RP", "Regional P&L", "Profit and loss cut by region, with head-office cost allocated out."],
        ["PR", "Participation Rules", "How profit splits among partners, branches and clients."],
        ["RM", "RMD Statements", "A running ledger per partner — drawings, contributions and profit allocations."],
        ["RS", "Regional Scorecard", "Operating and financial health, region by region."],
        ["PJ", "Project Financing", "Investors, capital and returns on funded projects."],
      ],
    },
    {
      title: "Compliance",
      sub: "Nothing expires without warning.",
      mods: [
        ["LR", "Licenses & Renewals", "One countdown across guard licences, weapons, medicals and contract renewals, sorted by days left."],
        ["CM", "Compliance Calendar", "Important dates, contract endings and recurring reminders."],
        ["CC", "Compliance Cases", "The licence, renewal and NOC case tracker, plus statutory filings."],
        ["DO", "Documents", "The central employee document repository, backed by Google Drive."],
      ],
    },
    {
      title: "Admin",
      sub: "Who can do what, and what everyone did.",
      mods: [
        ["AL", "Alerts", "Blocking, warning and dashboard-tier signals surfaced in one list."],
        ["TK", "Tasks", "The internal task board for the office."],
        ["AG", "Access & Governance", "Per-person permissions and branch scope, plus the approval workflow engine."],
        ["AU", "Audit Log", "Who changed what, when, and the exact before and after. Always on."],
        ["ST", "Settings", "Locations, regions, branches, dashboard widgets and the invoice template."],
      ],
    },
  ];
  const acc = root.getElementById("modAccordion");
  if (acc) {
    const CHEV = '<svg class="acc-chev" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    groups.forEach((g, gi) => {
      const rows = g.mods.map((m) => (
        '<div class="acc-mod">' +
          '<span class="acc-code">' + m[0] + "</span>" +
          '<div class="acc-mod-txt"><b>' + m[1] + "</b><span>" + m[2] + "</span></div>" +
        "</div>"
      )).join("");
      const num = ("0" + (gi + 1)).slice(-2);
      const item = document.createElement("div");
      item.className = "acc-item";
      item.innerHTML =
        '<button class="acc-head" type="button" aria-expanded="false">' +
          '<span class="acc-num">' + num + "</span>" +
          '<span class="acc-lead"><span class="acc-title">' + g.title + "</span>" +
          '<span class="acc-sub">' + g.sub + "</span></span>" +
          '<span class="acc-meta"><span class="acc-count">' + g.mods.length + " modules</span>" + CHEV + "</span>" +
        "</button>" +
        '<div class="acc-panel"><div class="acc-panel-inner"><div class="acc-mods">' + rows + "</div></div></div>";
      acc.appendChild(item);
    });
    on(acc, "click", (e) => {
      const head = (e.target as HTMLElement).closest(".acc-head");
      if (!head) return;
      const item = head.parentElement!;
      const open = item.classList.toggle("open");
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ---- live audit feed ----
     100 lines, every one an action the product can actually perform, so the
     feed doubles as a feature list you read without meaning to. Shuffled once
     per visit and then cycled forever, so the loop never repeats a line inside
     a pass but two visitors never see the same order. Money uses the real
     minus sign (−) to match the app's number formatting. */
  const events: Array<[string, string, string, string]> = [
    // ---- Revenue: invoices, payments, receivables ----
    ["in", "Invoice INV-057 marked Paid · UBL Collections", "+312,000", "pos"],
    ["in", "Client payment allocated oldest-first · 3 invoices", "+186,500", "pos"],
    ["in", "Auto-invoice run complete · 12 clients · PDFs generated", "+2,940,000", "pos"],
    ["in", "Part payment received · Dolmen City · balance carried", "+95,000", "pos"],
    ["in", "Invoice INV-061 raised from contract lines", "+418,000", "pos"],
    ["in", "Withholding tax recorded · filer · 4%", "+16,720", "pos"],
    ["in", "Receivable cleared · PCI · 62 days outstanding", "+240,000", "pos"],
    ["in", "Cash sale receipt · ad-hoc event cover", "+75,000", "pos"],
    ["in", "Client statement issued · Nova Group · 6 invoices", "", ""],
    ["evt", "Invoice structure saved · per-category rates · MIU", "", ""],
    ["evt", "Credit note applied · short-billed guard-day", "", ""],
    ["in", "Advance billing received · Lexus Tower · month ahead", "+520,000", "pos"],

    // ---- Payroll ----
    ["out", "Payroll disbursed · HBL Main · advance cleared", "−45,000", "negv"],
    ["evt", "Payroll run moved to Review · June · 214 payslips", "", ""],
    ["evt", "Payroll run approved · Finance Director sign-off", "", ""],
    ["out", "Batch disbursement complete · 68 guards · UBL Payroll", "−2,684,000", "negv"],
    ["evt", "Payslip generated · prorated 18 of 30 days", "", ""],
    ["out", "Advance recovered on payslip · GGS-00228", "−3,000", "negv"],
    ["out", "EOBI deducted · 41 guards", "−41,000", "negv"],
    ["evt", "Leave beyond allowance docked · 2 days", "", ""],
    ["evt", "Un-disbursed payslip reversed · balance restored", "", ""],
    ["evt", "Double payment blocked · payslip already claimed", "", ""],
    ["out", "Final settlement paid · separated guard", "−28,400", "negv"],
    ["evt", "Payroll period locked · no further edits", "", ""],
    ["out", "Reliever payout · 14 covered days · Nova Group", "−19,600", "negv"],

    // ---- Attendance ----
    ["evt", "Shift confirmed · Dolmen City · night · 12 present", "", ""],
    ["evt", "Exception entered · 1 absent · rest presumed present", "", ""],
    ["evt", "Bulk mark by employee · 24 days · GGS-00113", "", ""],
    ["evt", "Reliever day tagged to client DEF · attributed", "", ""],
    ["evt", "Double duty recorded · day + night · same date", "", ""],
    ["evt", "Backdated mark blocked · supervisor override required", "", ""],
    ["evt", "Marking refused · outside employment window", "", ""],
    ["evt", "Overtime logged · 3 hours · Gate A", "", ""],
    ["evt", "Half-day recorded · late arrival flagged", "", ""],
    ["evt", "Timesheet correction filed · May · 2 days amended", "", ""],
    ["evt", "Attendance exported · June · 214 guards · Excel", "", ""],

    // ---- Banking, cheques, cash ----
    ["out", "Cheque #4471 cleared · UBL Payroll", "−128,400", "negv"],
    ["evt", "Cheque #4482 issued · post-dated 15 Aug", "", ""],
    ["evt", "Cheque #4468 bounced · marked, balance untouched", "", ""],
    ["out", "Wire transfer · HBL Main → UBL Payroll", "500,000", ""],
    ["in", "Cash deposit synced to custody · Cash in Hand", "+60,000", "pos"],
    ["out", "Bank charges posted · HBL Main", "−1,150", "negv"],
    ["evt", "Bank reconciliation complete · HBL Main · 0 variance", "", ""],
    ["in", "Deposit slip recorded · branch cash → bank", "+340,000", "pos"],
    ["evt", "Cash custody reconciled · custodian handover", "", ""],
    ["out", "Cash handed to custodian · Islamabad office", "−80,000", "negv"],
    ["in", "Inter-region loan received · North → HO", "+250,000", "pos"],

    // ---- Expenses & advances ----
    ["out", "Expense paid · fuel · cost of services", "−18,200", "negv"],
    ["out", "Advance issued · guard request · recover next payslip", "−10,000", "negv"],
    ["out", "Office rent paid · Islamabad · cheque", "−145,000", "negv"],
    ["out", "Uniform purchase · 40 sets", "−92,000", "negv"],
    ["out", "Vehicle maintenance · patrol van", "−23,500", "negv"],
    ["evt", "Expense marked payable · settles on due date", "", ""],
    ["evt", "Expense attributed to client · billable cost", "", ""],
    ["out", "Ammunition restock · licensed store", "−54,000", "negv"],

    // ---- Compliance & licences ----
    ["evt", "Licence expiring in 12 days · weapon #A-238", "", ""],
    ["evt", "Guard-service licence renewed · 2 years", "", ""],
    ["evt", "Medical fitness expired · guard flagged off-duty", "", ""],
    ["evt", "Police verification cleared · GGS-00471", "", ""],
    ["evt", "NADRA Verisys returned · identity confirmed", "", ""],
    ["evt", "NOC filing due in 21 days · reminder sent", "", ""],
    ["evt", "Contract renewal raised · ABC · expires 30 Sep", "", ""],
    ["evt", "Compliance case opened · weapon licence renewal", "", ""],
    ["evt", "Statutory filing marked submitted · monthly", "", ""],
    ["evt", "Probation ending in 7 days · 3 guards", "", ""],
    ["evt", "Email alert sent · 4 expiries inside 90 days", "", ""],

    // ---- Operations ----
    ["evt", "Incident logged · no-show · Post 12 · client notified", "", ""],
    ["evt", "Client complaint logged · escalated to ops", "", ""],
    ["evt", "Daily report generated · 14 posts · PDF sent", "", ""],
    ["evt", "Deployment short · PCI · 14 of 15 · reliever raised", "", ""],
    ["evt", "Strength restored · Nova Group · back at 8 of 8", "", ""],
    ["evt", "Addendum filed · +5 guards for ABC · eff 01 Mar", "", ""],
    ["evt", "Guard posted · Dolmen City · from 01 Aug", "", ""],
    ["evt", "Posting closed on separation · vacancy raised", "", ""],

    // ---- Workforce & assets ----
    ["evt", "Candidate moved to Interview · pipeline updated", "", ""],
    ["evt", "Candidate hired · onboarding started in Employees", "", ""],
    ["evt", "Guard record ops-verified · awaiting finance approval", "", ""],
    ["evt", "Weapon issued · shotgun #S-114 · signed out", "", ""],
    ["evt", "Uniform issued · 3 sets · deducted from stock", "", ""],
    ["evt", "Kit returned at exit · clearance cleared", "", ""],
    ["evt", "Guard separated · last working day 10/07", "", ""],
    ["evt", "Rehire relinked to the same permanent code", "", ""],
    ["evt", "Document uploaded · CNIC copy · Drive", "", ""],
    ["evt", "Shift changed · dated · past attendance untouched", "", ""],
    ["evt", "Appraisal approved · KPI score recorded", "", ""],
    ["evt", "Bonus pool released · 14 guards", "", ""],

    // ---- Books, partners, control ----
    ["evt", "Period closed · June locked app-wide", "", ""],
    ["evt", "Trial balance balanced · 0.00 variance", "", ""],
    ["evt", "Opening balances posted · receivables carried in", "", ""],
    ["evt", "Journal written under payment · double entry", "", ""],
    ["evt", "Regional P&L updated · North · HO cost allocated", "", ""],
    ["out", "Partner drawing recorded · RMD statement", "−150,000", "negv"],
    ["evt", "Profit allocated · participation rule 60/40", "", ""],
    ["in", "Investor capital received · project financing", "+1,000,000", "pos"],
    ["evt", "Reserve accrual posted · bonus reserve", "", ""],
    ["evt", "Regional scorecard refreshed · 4 regions", "", ""],
    ["evt", "Permission revoked · accounting.edit · 1 user", "", ""],
    ["evt", "User scoped to branch · Islamabad only", "", ""],
    ["evt", "Audit entry written · salary changed · before/after kept", "", ""],
    ["evt", "Task assigned · collect PCI payment · due Friday", "", ""],
  ];
  // Fisher-Yates, once, so the order differs per visit without ever repeating.
  for (let i = events.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }
  const feed = root.getElementById("feedList");
  const ROWS = 6;
  if (feed) {
    let idx = 0;
    const makeRow = (ev: (typeof events)[number], fresh: boolean) => {
      const li = document.createElement("li");
      if (fresh) li.className = "fresh";
      const amt = ev[2] ? '<span class="fm ' + ev[3] + '">' + ev[2] + "</span>" : "";
      li.innerHTML = '<span class="feed-dot ' + ev[0] + '"></span><span class="ft">' + ev[1] + "</span>" + amt;
      return li;
    };
    for (let i = 0; i < ROWS; i++) {
      feed.appendChild(makeRow(events[i % events.length], false));
      idx = (i + 1) % events.length;
    }
    if (!reduce) {
      const timer = window.setInterval(() => {
        feed.insertBefore(makeRow(events[idx], true), feed.firstChild);
        if (feed.children.length > ROWS) feed.removeChild(feed.lastChild!);
        idx = (idx + 1) % events.length;
      }, 2600);
      cleanups.push(() => window.clearInterval(timer));
    }
  }

  /* ---- advantages carousel: auto-glide + chevron controls ---- */
  const advMarquee = root.getElementById("advMarquee");
  const advTrack = root.getElementById("advTrack");
  if (advMarquee && advTrack) {
    Array.prototype.slice.call(advTrack.children).forEach((c: Element) => {
      const clone = c.cloneNode(true) as Element;
      clone.setAttribute("aria-hidden", "true");
      advTrack.appendChild(clone);
    });

    let setWidth = 0;
    let step = 360;
    const measure = () => {
      setWidth = advTrack.scrollWidth / 2;
      const card = advTrack.querySelector(".adv-card") as HTMLElement | null;
      if (card) {
        step = card.getBoundingClientRect().width + parseFloat(getComputedStyle(card).marginRight || "0");
      }
    };
    measure();
    on(window, "resize", measure);

    const wrap = () => {
      if (!setWidth) return;
      if (advMarquee.scrollLeft >= setWidth) advMarquee.scrollLeft -= setWidth;
      else if (advMarquee.scrollLeft < 0) advMarquee.scrollLeft += setWidth;
    };

    let paused = false;
    let resumeT: number | undefined;
    const hold = (ms?: number) => {
      paused = true;
      window.clearTimeout(resumeT);
      resumeT = window.setTimeout(() => { paused = false; }, ms || 2800);
    };
    on(advMarquee, "mouseenter", () => { paused = true; window.clearTimeout(resumeT); });
    on(advMarquee, "mouseleave", () => { paused = false; });

    if (!reduce) {
      let raf = 0;
      const loop = () => {
        if (!paused) { advMarquee.scrollLeft += 0.5; wrap(); }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      cleanups.push(() => cancelAnimationFrame(raf));
    }

    const move = (dir: number) => {
      hold(3200);
      const s = advMarquee.scrollLeft;
      if (dir < 0 && s < step) advMarquee.scrollLeft = s + setWidth;
      else if (dir > 0 && s > setWidth - step) advMarquee.scrollLeft = s - setWidth;
      advMarquee.scrollBy({ left: dir * step, behavior: reduce ? "auto" : "smooth" });
    };
    const prevBtn = root.getElementById("advPrev");
    const nextBtn = root.getElementById("advNext");
    if (prevBtn) on(prevBtn, "click", () => move(-1));
    if (nextBtn) on(nextBtn, "click", () => move(1));
  }

  return () => { cleanups.forEach((fn) => fn()); };
}
