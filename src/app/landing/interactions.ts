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

  /* ---- modules accordion (grouped by stage) ---- */
  const groups: Array<{ title: string; sub: string; mods: Array<[string, string, string]> }> = [
    {
      title: "Clients & deals",
      sub: "Who you guard, and the deal you signed.",
      mods: [
        ["CL", "Clients", "The master anchor. Tax profile, remit accounts and ID prefix flow everywhere downstream."],
        ["CT", "Contracts", "Lines, rates and committed headcount, with dated addendums that keep true history."],
        ["IN", "Invoices", "Built from contract lines and tax profile; tracked from raised to fully paid."],
      ],
    },
    {
      title: "Workforce & payroll",
      sub: "Every guard, their days, and their pay.",
      mods: [
        ["EM", "Employees", "Every guard and staffer, with a full ID history trail on reassignment."],
        ["AT", "Attendance", "The daily heartbeat. Present, absent, leave and overtime drive the payslip."],
        ["PR", "Payroll", "Attendance becomes money: prorated, leave aware, advance netted payslips."],
        ["RV", "Relievers", "Floating guards attributed per day to the client they actually covered."],
      ],
    },
    {
      title: "Money & banking",
      sub: "Every rupee through your banks and cash box.",
      mods: [
        ["BK", "Banks & Ledgers", "Four tabs, every rupee. Deposits, withdrawals, transfers and live balances."],
        ["CQ", "Cheques", "Modeled as promises. The bank only moves when the cheque clears."],
        ["EX", "Expenses", "Costs and advances by cash, bank, payable or cheque; auto recovered next payslip."],
        ["CF", "Cash Flow", "A read only netting view: revenue minus payroll, expenses and advances."],
        ["CC", "Cash Custody", "Where all the physical cash sits, reconciled against partners and investors."],
      ],
    },
    {
      title: "Books & partnership",
      sub: "The accountant's view, and the partners' share.",
      mods: [
        ["FR", "Financial Reports", "P&L, partnership position and full printable client statements."],
        ["CA", "Chart of Accounts", "A self maintaining trial balance from the double entry journal underneath."],
        ["PC", "Period Close", "Lock a month app wide so signed off figures can't shift underneath you."],
        ["PF", "Partnership", "Partner ledgers, profit split rules and project financing for investors."],
      ],
    },
    {
      title: "Operations & assets",
      sub: "Plan the posts, log the events, track the kit.",
      mods: [
        ["RO", "Deployment Roster", "Assign guards to posts and shifts; gaps and reliever needs at a glance."],
        ["IC", "Incidents", "Client, post and named guards on one record, with severity and status."],
        ["IV", "Inventory", "Weapons and uniforms, who holds them, and licence expiries tracked."],
      ],
    },
    {
      title: "Compliance & control",
      sub: "Nothing expires, and everything is on the record.",
      mods: [
        ["LR", "Licences & Renewals", "One countdown across guards, weapons and contracts. Nothing lapses unseen."],
        ["CM", "Compliance Calendar", "Renewals, filings and deadlines with recurring reminders."],
        ["AU", "Audit Log", "Who changed what, when, and the exact before and after. Always on."],
        ["AI", "AI Assistant", "Ask your data in plain language. It reads, never changes, your records."],
        ["ST", "Settings", "Branches, dashboard widgets, invoice template, brand and fiscal year."],
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

  /* ---- live audit feed ---- */
  const events: Array<[string, string, string, string]> = [
    ["in", "Invoice INV-057 marked Paid · UBL Collections", "+312,000", "pos"],
    ["out", "Payroll disbursed · HBL Main · advance cleared", "−45,000", "negv"],
    ["evt", "Addendum filed · +5 guards for ABC · eff 01 Mar", "", ""],
    ["out", "Cheque #4471 cleared · UBL Payroll", "−128,400", "negv"],
    ["evt", "Incident logged · no-show · Post 12 · client notified", "", ""],
    ["in", "Client payment allocated oldest-first · 3 invoices", "+186,500", "pos"],
    ["evt", "Reliever day tagged to client DEF · attributed", "", ""],
    ["evt", "Licence expiring in 12 days · weapon #A-238", "", ""],
    ["out", "Wire transfer · HBL Main → UBL Payroll", "500,000", ""],
    ["evt", "Period closed · June locked app-wide", "", ""],
    ["in", "Cash deposit synced to custody · Cash in Hand", "+60,000", "pos"],
    ["out", "Expense paid · fuel · cost of services", "−18,200", "negv"],
  ];
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
