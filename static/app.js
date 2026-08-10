/* Stocks Dashboard client — polls /api/dashboard every 60s and renders:
   hero KPIs, movers-with-news, market headlines, performance vs SPY,
   sector exposure, allocation, holdings table, holdings news. */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const main = $("main");
  const tooltip = $("tooltip");
  const REFRESH_MS = 60 * 1000;
  const SVGNS = "http://www.w3.org/2000/svg";

  const fmtUSD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const fmtUSD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const fmtQty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

  function money(v, f) { return v === null || v === undefined ? "—" : (f || fmtUSD).format(v); }
  function signed(v, f) {
    if (v === null || v === undefined) return "—";
    return (v >= 0 ? "+" : "−") + (f || fmtUSD).format(Math.abs(v));
  }
  function signedPct(v, digits) {
    if (v === null || v === undefined) return "—";
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(digits === undefined ? 2 : digits) + "%";
  }
  function updown(v) { return v > 0 ? "up" : v < 0 ? "down" : "flat"; }
  function arrow(v) { return v >= 0 ? "▲" : "▼"; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function timeAgo(epoch) {
    if (!epoch) return "";
    const mins = Math.round(Date.now() / 1000 / 60 - epoch / 60);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.round(hrs / 24) + "d ago";
  }
  function dayLabel(epochDay) {
    return new Date(epochDay * 86400 * 1000)
      .toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  // ---- tooltip -------------------------------------------------------------

  function showTooltip(evt, html) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const pad = 14;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    const r = tooltip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }
  function hideTooltip() { tooltip.hidden = true; }
  function attachTip(el, htmlFn) {
    el.addEventListener("mousemove", (e) => showTooltip(e, htmlFn()));
    el.addEventListener("mouseleave", hideTooltip);
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // ---- hero KPIs -----------------------------------------------------------

  function renderKpis(portfolio) {
    const t = portfolio.totals;
    const pos = portfolio.positions;
    $("kpi-total").textContent = fmtUSD.format(t.market_value);
    $("kpi-total-delta").innerHTML =
      `<span class="${updown(t.day_change)}">${arrow(t.day_change)} ${signed(t.day_change)} (${signedPct(t.day_change_pct)})</span> today · ` +
      `<span class="${updown(t.unrealized_pl)}">${signedPct(t.unrealized_pl_pct, 1)}</span> all-time`;

    setStat("kpi-day", signed(t.day_change), updown(t.day_change));

    const spy = pos.find((p) => p.symbol === "SPY");
    if (spy && spy.day_change_pct !== null && t.day_change_pct !== null) {
      const diff = t.day_change_pct - spy.day_change_pct;
      setStat("kpi-vs-spy", signedPct(diff) + " pts", updown(diff));
    } else {
      setStat("kpi-vs-spy", "—", "flat");
    }

    setStat("kpi-unreal", signed(t.unrealized_pl), updown(t.unrealized_pl));

    const movers = pos.filter((p) => p.day_change_pct !== null);
    const ups = movers.filter((p) => p.day_change_pct > 0).length;
    const downs = movers.filter((p) => p.day_change_pct < 0).length;
    $("kpi-breadth").innerHTML =
      `<span class="up">${ups}</span> <span class="flat">/</span> <span class="down">${downs}</span>`;

    const valued = pos.filter((p) => p.market_value > 0);
    const top5 = valued.slice(0, 5).reduce((s, p) => s + p.market_value, 0);
    setStat("kpi-conc", (top5 / t.market_value * 100).toFixed(0) + "%",
      top5 / t.market_value > 0.6 ? "down" : "flat");
  }

  function setStat(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = "hstat-value " + (cls || "");
  }

  // ---- movers with their headlines ("why it's moving") ---------------------

  function renderMovers(positions, portfolioNews) {
    const host = $("movers");
    const movers = positions
      .filter((p) => p.day_change_pct !== null && p.market_value > 0)
      .sort((a, b) => Math.abs(b.day_change_pct) - Math.abs(a.day_change_pct))
      .slice(0, 8);
    const maxAbs = Math.max(...movers.map((p) => Math.abs(p.day_change_pct)), 0.01);

    host.innerHTML = movers.map((p) => {
      const gain = p.day_change_pct >= 0;
      const w = Math.max(2, Math.abs(p.day_change_pct) / maxAbs * 50);
      const items = portfolioNews.filter((n) => n.ticker === p.symbol).slice(0, 2);
      const newsHtml = items.length
        ? `<ul class="mover-news">` + items.map((n) =>
            `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>` +
            `<span class="src">${esc(n.source)}${n.published ? " · " + timeAgo(n.published) : ""}</span></li>`
          ).join("") + `</ul>`
        : `<p class="mover-news mover-nonews">No fresh headlines — likely moving with its sector or the broader market.</p>`;
      return `<li>
        <div class="mover-row">
          <span class="mover-sym">${esc(p.symbol)}</span>
          <span class="mover-bar-track" aria-hidden="true">
            <span class="mover-bar" style="left:${gain ? 50 : 50 - w}%;width:${w}%;background:var(--${gain ? "up" : "down"})"></span>
          </span>
          <span class="mover-pct ${updown(p.day_change_pct)}">${arrow(p.day_change_pct)} ${signedPct(p.day_change_pct)}</span>
        </div>
        ${newsHtml}
      </li>`;
    }).join("");
  }

  // ---- news lists ----------------------------------------------------------

  function renderNews(listEl, items, showTicker, max) {
    listEl.innerHTML = items.slice(0, max || 40).map((n) => `
      <li>
        ${showTicker && n.ticker ? `<span class="news-ticker">${esc(n.ticker)}</span>` : ""}
        <div>
          <a class="news-title" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>
          <span class="news-meta">${esc(n.source)}${n.published ? " · " + timeAgo(n.published) : ""}</span>
        </div>
      </li>`).join("") || "<li>No headlines right now.</li>";
  }

  // ---- performance vs indices (interactive line chart, indexed) ------------

  const BENCH_COLORS = {
    SPY: "var(--bench-spy)",
    QQQ: "var(--bench-qqq)",
    DIA: "var(--bench-dia)",
  };

  const perfState = {
    range: localStorage.getItem("perfRange") || "all",
    bench: new Set(JSON.parse(localStorage.getItem("perfBench") || '["SPY"]')),
  };

  function savePerfState() {
    localStorage.setItem("perfRange", perfState.range);
    localStorage.setItem("perfBench", JSON.stringify([...perfState.bench]));
  }

  function renderPerfControls(history) {
    document.querySelectorAll("#perf-range .chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(chip.dataset.range === perfState.range));
    });
    $("perf-bench").innerHTML = (history && history.benchmarks || []).map((b) => `
      <button type="button" class="chip" data-sym="${esc(b.symbol)}" title="${esc(b.label)}"
              aria-pressed="${perfState.bench.has(b.symbol)}">
        <span class="dot" style="background:${BENCH_COLORS[b.symbol] || "var(--neutral-ln)"}"></span>${esc(b.symbol)}
      </button>`).join("");
  }

  function renderPerf(history) {
    const host = $("chart-perf");
    host.textContent = "";
    if (!history || !history.value || history.value.length < 2) {
      host.textContent = "Not enough history yet.";
      return;
    }
    const n = perfState.range === "21"
      ? Math.min(22, history.days.length)
      : history.days.length;
    const days = history.days.slice(-n);

    function rebase(vals) {
      const sliced = vals.slice(-n);
      const base = sliced.find((v) => v !== null && v !== undefined);
      return sliced.map((v) => (v === null || v === undefined || !base ? null : v / base * 100));
    }

    const series = [
      { label: "You", color: "var(--accent)", width: 2.4, vals: rebase(history.value) },
    ];
    (history.benchmarks || []).forEach((b) => {
      if (perfState.bench.has(b.symbol)) {
        series.push({
          label: b.symbol,
          color: BENCH_COLORS[b.symbol] || "var(--neutral-ln)",
          width: 2,
          vals: rebase(b.values),
        });
      }
    });

    const W = 640, H = 240, L = 40, R = 84, T = 12, B = 26;
    const all = series.flatMap((s) => s.vals.filter((v) => v !== null));
    const lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || 1;
    const y = (v) => T + (hi + pad - v) / (hi - lo + 2 * pad) * (H - T - B);
    const x = (i) => L + i / (days.length - 1) * (W - L - R);

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "Portfolio vs index benchmarks, indexed to 100" });

    for (let g = 0; g < 4; g++) {
      const v = lo + (hi - lo) * g / 3;
      svg.append(svgEl("line", { x1: L, y1: y(v), x2: W - R, y2: y(v), class: "grid-line" }));
      const t = svgEl("text", { x: L - 6, y: y(v) + 3, "text-anchor": "end", class: "axis-tick" });
      t.textContent = v.toFixed(0);
      svg.append(t);
    }
    [0, Math.floor(days.length / 2), days.length - 1].forEach((i) => {
      const t = svgEl("text", { x: x(i), y: H - 8,
        "text-anchor": i === 0 ? "start" : i === days.length - 1 ? "end" : "middle", class: "axis-tick" });
      t.textContent = dayLabel(days[i]);
      svg.append(t);
    });

    function linePath(vals) {
      let d = "";
      vals.forEach((v, i) => {
        if (v === null) return;
        d += (d ? " L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1);
      });
      return d;
    }

    // benchmarks under, portfolio on top
    series.slice(1).forEach((s) => {
      svg.append(svgEl("path", { d: linePath(s.vals), fill: "none",
        stroke: s.color, "stroke-width": s.width }));
    });
    svg.append(svgEl("path", { d: linePath(series[0].vals), fill: "none",
      stroke: series[0].color, "stroke-width": series[0].width }));

    // direct labels at line ends, staggered so they never overlap
    const labels = series
      .map((s) => {
        const last = [...s.vals].reverse().find((v) => v !== null);
        return last === undefined ? null : { s, last, y: y(last) + 4 };
      })
      .filter(Boolean)
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    }
    labels.forEach((l) => {
      const t = svgEl("text", { x: W - R + 8, y: l.y, class: "bar-label" });
      t.style.fill = l.s.color;
      t.textContent = `${l.s.label} ${signedPct(l.last - 100, 1)}`;
      svg.append(t);
    });

    // crosshair + hover
    const cross = svgEl("line", { y1: T, y2: H - B, class: "axis-line", opacity: 0 });
    svg.append(cross);
    const dots = series.map((s) => {
      const d = svgEl("circle", { r: 3.5, fill: s.color, opacity: 0 });
      svg.append(d);
      return d;
    });
    const hit = svgEl("rect", { x: L, y: 0, width: W - L - R, height: H, fill: "transparent" });
    svg.append(hit);

    hit.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width * W;
      const i = Math.max(0, Math.min(days.length - 1,
        Math.round((px - L) / (W - L - R) * (days.length - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
      cross.setAttribute("opacity", 1);
      let rows = "";
      series.forEach((s, k) => {
        const v = s.vals[i];
        if (v === null) { dots[k].setAttribute("opacity", 0); return; }
        dots[k].setAttribute("cx", x(i));
        dots[k].setAttribute("cy", y(v));
        dots[k].setAttribute("opacity", 1);
        rows += `<div class="tt-row">${esc(s.label)} ${v.toFixed(1)} (${signedPct(v - 100, 1)})</div>`;
      });
      showTooltip(e, `<div class="tt-title">${dayLabel(days[i])}</div>` + rows);
    });
    hit.addEventListener("mouseleave", () => {
      cross.setAttribute("opacity", 0);
      dots.forEach((d) => d.setAttribute("opacity", 0));
      hideTooltip();
    });

    host.append(svg);
  }

  function renderPerfSide(portfolio) {
    const host = $("perf-side");
    const withRet = portfolio.positions.filter((p) => p.returns && p.returns["1m"] !== null && p.market_value > 0);
    const best = withRet.slice().sort((a, b) => b.returns["1m"] - a.returns["1m"])[0];
    const worst = withRet.slice().sort((a, b) => a.returns["1m"] - b.returns["1m"])[0];
    const h = portfolio.history;
    const ret3m = h && h.value.length > 1 ? (h.value[h.value.length - 1] / h.value[0] - 1) * 100 : null;
    const spyB = h && (h.benchmarks || []).find((b) => b.symbol === "SPY");
    const spy3m = spyB && spyB.values[0]
      ? (spyB.values[spyB.values.length - 1] / spyB.values[0] - 1) * 100 : null;
    host.innerHTML = `
      <div class="pstat">
        <p class="micro-label">Your 3-month return</p>
        <p class="pstat-value ${ret3m === null ? "" : updown(ret3m)}">${signedPct(ret3m, 1)}</p>
        <p class="pstat-note">S&amp;P 500: ${signedPct(spy3m, 1)}</p>
      </div>
      ${best ? `<div class="pstat">
        <p class="micro-label">Best this month</p>
        <p class="pstat-value up">${esc(best.symbol)} ${signedPct(best.returns["1m"], 1)}</p>
      </div>` : ""}
      ${worst ? `<div class="pstat">
        <p class="micro-label">Worst this month</p>
        <p class="pstat-value down">${esc(worst.symbol)} ${signedPct(worst.returns["1m"], 1)}</p>
      </div>` : ""}`;
  }

  // ---- horizontal bar charts (single hue) ----------------------------------

  const BAR = { labelW: 108, valueW: 84, barH: 16, rowH: 26, pad: 6 };

  function roundedRightRect(x, y, w, h, r) {
    r = Math.min(r, w);
    return `M${x},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} Z`;
  }

  function hBarChart(host, rows, opts) {
    host.textContent = "";
    const W = 560;
    const H = rows.length * BAR.rowH + BAR.pad * 2;
    const plotW = W - opts.labelW - BAR.valueW;
    const max = Math.max(...rows.map((r) => r.value));
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.ariaLabel });
    rows.forEach((row, i) => {
      const y = BAR.pad + i * BAR.rowH;
      const w = Math.max(2, row.value / max * plotW);
      const label = svgEl("text", { x: opts.labelW - 8, y: y + BAR.barH - 3, "text-anchor": "end", class: "bar-label" });
      label.textContent = row.label;
      const bar = svgEl("path", { fill: "var(--accent-dim)", d: roundedRightRect(opts.labelW, y, w, BAR.barH, 4) });
      const val = svgEl("text", { x: opts.labelW + w + 6, y: y + BAR.barH - 3, class: "bar-value" });
      val.textContent = row.valueLabel;
      const hit = svgEl("rect", { x: 0, y: y - 2, width: W, height: BAR.rowH, fill: "transparent" });
      attachTip(hit, () => row.tip);
      svg.append(label, bar, val, hit);
    });
    svg.append(svgEl("line", { x1: opts.labelW, y1: BAR.pad - 2, x2: opts.labelW, y2: H - BAR.pad + 2, class: "axis-line" }));
    host.append(svg);
  }

  function renderSectors(sectors, total) {
    hBarChart($("chart-sectors"), sectors.map((s) => ({
      label: s.sector,
      value: s.value,
      valueLabel: (s.value / total * 100).toFixed(1) + "%",
      tip: `<div class="tt-title">${esc(s.sector)}</div>` +
           `<div class="tt-row">${fmtUSD0.format(s.value)} · ${(s.value / total * 100).toFixed(1)}% of portfolio</div>`,
    })), { labelW: 108, ariaLabel: "Sector exposure as share of portfolio value" });
  }

  function renderAllocation(positions, total) {
    const valued = positions.filter((p) => p.market_value > 0);
    const TOP = 12;
    const rows = valued.slice(0, TOP).map((p) => ({
      label: p.symbol,
      value: p.market_value,
      valueLabel: fmtUSD0.format(p.market_value),
      tip: `<div class="tt-title">${esc(p.symbol)}</div>` +
           `<div class="tt-row">${fmtUSD.format(p.market_value)} · ${(p.market_value / total * 100).toFixed(1)}%</div>` +
           `<div class="tt-row">${fmtQty.format(p.quantity)} sh @ ${money(p.price)}</div>`,
    }));
    const tail = valued.slice(TOP);
    if (tail.length) {
      const sum = tail.reduce((s, p) => s + p.market_value, 0);
      rows.push({
        label: "Other (" + tail.length + ")",
        value: sum,
        valueLabel: fmtUSD0.format(sum),
        tip: `<div class="tt-title">Other</div><div class="tt-row">${tail.length} smaller positions · ${fmtUSD0.format(sum)} — see table</div>`,
      });
    }
    hBarChart($("chart-allocation"), rows, { labelW: 88, ariaLabel: "Allocation by market value, largest first" });
  }

  // ---- holdings table ------------------------------------------------------

  function retCell(v) {
    return `<td class="num ${v === null || v === undefined ? "" : updown(v)}">${signedPct(v, 1)}</td>`;
  }

  function sparkline(values) {
    if (!values || values.length < 2) return "";
    const W = 84, H = 24, pad = 2;
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const step = (W - pad * 2) / (values.length - 1);
    const pts = values.map((v, i) =>
      `${(pad + i * step).toFixed(1)},${(H - pad - ((v - min) / span) * (H - pad * 2)).toFixed(1)}`);
    const first = pts[0].split(",");
    const last = pts[pts.length - 1].split(",");
    return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <path class="ar" d="M${first[0]},${H - pad} L${pts.join(" L")} L${last[0]},${H - pad} Z"/>
      <path class="ln" d="M${pts.join(" L")}"/></svg>`;
  }

  const tableState = { key: "market_value", dir: -1, filter: "" };

  function sortVal(p, key) {
    switch (key) {
      case "ret_1w": return p.returns ? p.returns["1w"] : null;
      case "ret_1m": return p.returns ? p.returns["1m"] : null;
      case "ret_3m": return p.returns ? p.returns["3m"] : null;
      default: return p[key];
    }
  }

  function renderTable(portfolio) {
    const tbody = $("holdings").querySelector("tbody");
    const tfoot = $("holdings").querySelector("tfoot");
    const t = portfolio.totals;

    document.querySelectorAll("#holdings th.sortable").forEach((th) => {
      th.removeAttribute("aria-sort");
      if (th.dataset.key === tableState.key) {
        th.setAttribute("aria-sort", tableState.dir === 1 ? "ascending" : "descending");
      }
    });

    const rows = portfolio.positions
      .filter((p) => !tableState.filter || p.symbol.toLowerCase().includes(tableState.filter))
      .sort((a, b) => {
        const va = sortVal(a, tableState.key), vb = sortVal(b, tableState.key);
        if (va === null || va === undefined) return 1;   // nulls always last
        if (vb === null || vb === undefined) return -1;
        if (typeof va === "string") return va.localeCompare(vb) * tableState.dir;
        return (va - vb) * tableState.dir;
      });

    tbody.innerHTML = rows.map((p) => `
      <tr>
        <td class="sym">${esc(p.symbol)}${p.live ? "" : '<span class="stale-dot" title="No live quote; using last stored price">stale</span>'}</td>
        <td class="num">${fmtQty.format(p.quantity)}</td>
        <td class="num">${money(p.avg_buy_price)}</td>
        <td class="num">${money(p.price)}</td>
        <td class="num ${p.day_change_pct === null ? "" : updown(p.day_change_pct)}">${p.day_change_pct === null ? "—" : arrow(p.day_change_pct) + " " + signedPct(p.day_change_pct)}</td>
        ${retCell(p.returns && p.returns["1w"])}
        ${retCell(p.returns && p.returns["1m"])}
        ${retCell(p.returns && p.returns["3m"])}
        <td class="num">${p.vol === null || p.vol === undefined ? "—" : p.vol.toFixed(0) + "%"}</td>
        <td class="num">${money(p.market_value)}</td>
        <td class="num ${p.unrealized_pl === null ? "" : updown(p.unrealized_pl)}">${signed(p.unrealized_pl)}</td>
        <td class="num ${p.unrealized_pl === null ? "" : updown(p.unrealized_pl)}">${p.unrealized_pl_pct === null ? "—" : signedPct(p.unrealized_pl_pct, 1)}</td>
        <td>${sparkline(p.spark)}</td>
      </tr>`).join("");
    tfoot.innerHTML = `
      <tr>
        <td>Total</td><td></td><td></td><td></td>
        <td class="num ${updown(t.day_change)}">${signedPct(t.day_change_pct)}</td>
        <td></td><td></td><td></td><td></td>
        <td class="num">${fmtUSD.format(t.market_value)}</td>
        <td class="num ${updown(t.unrealized_pl)}">${signed(t.unrealized_pl)}</td>
        <td class="num ${updown(t.unrealized_pl)}">${signedPct(t.unrealized_pl_pct, 1)}</td>
        <td></td>
      </tr>`;
    $("holdings-asof").textContent = portfolio.market_time
      ? "prices as of " + new Date(portfolio.market_time * 1000).toLocaleString()
      : "";
  }

  // ---- live status / countdown ---------------------------------------------

  let nextRefresh = Date.now() + REFRESH_MS;
  let lastUpdated = null;

  setInterval(() => {
    if (!lastUpdated) return;
    const secs = Math.max(0, Math.round((nextRefresh - Date.now()) / 1000));
    $("live-status").textContent =
      `LIVE · prices ${lastUpdated.toLocaleTimeString()} · next in ${secs}s`;
  }, 1000);

  // ---- interactivity wiring ------------------------------------------------

  let lastData = null;

  $("perf-range").addEventListener("click", (e) => {
    const chip = e.target.closest("button[data-range]");
    if (!chip) return;
    perfState.range = chip.dataset.range;
    savePerfState();
    if (lastData) {
      renderPerfControls(lastData.portfolio.history);
      renderPerf(lastData.portfolio.history);
    }
  });

  $("perf-bench").addEventListener("click", (e) => {
    const chip = e.target.closest("button[data-sym]");
    if (!chip) return;
    const sym = chip.dataset.sym;
    if (perfState.bench.has(sym)) perfState.bench.delete(sym);
    else perfState.bench.add(sym);
    savePerfState();
    if (lastData) {
      renderPerfControls(lastData.portfolio.history);
      renderPerf(lastData.portfolio.history);
    }
  });

  document.querySelector("#holdings thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    if (tableState.key === th.dataset.key) {
      tableState.dir = -tableState.dir;
    } else {
      tableState.key = th.dataset.key;
      tableState.dir = th.dataset.key === "symbol" ? 1 : -1;
    }
    if (lastData) renderTable(lastData.portfolio);
  });

  $("holdings-filter").addEventListener("input", (e) => {
    tableState.filter = e.target.value.trim().toLowerCase();
    if (lastData) renderTable(lastData.portfolio);
  });

  // ---- load ----------------------------------------------------------------

  async function load() {
    main.dataset.loading = "true";
    try {
      const resp = await fetch("/api/dashboard", { headers: { Accept: "application/json" } });
      if (resp.status === 401) { window.location.href = "/login"; return; }
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      lastData = data;
      const pf = data.portfolio;
      renderKpis(pf);
      renderMovers(pf.positions, data.news.portfolio);
      renderNews($("news-market"), data.news.market, false, 12);
      renderPerfControls(pf.history);
      renderPerf(pf.history);
      renderPerfSide(pf);
      renderSectors(pf.sectors, pf.totals.market_value);
      renderAllocation(pf.positions, pf.totals.market_value);
      renderTable(pf);
      renderNews($("news-portfolio"), data.news.portfolio, true, 30);
      const newsTimes = data.news.market.concat(data.news.portfolio)
        .map((n) => n.published).filter(Boolean);
      if (newsTimes.length) {
        $("news-updated").textContent = "newest item " + timeAgo(Math.max(...newsTimes));
      }
      lastUpdated = new Date(data.generated_at * 1000);
      $("load-error").hidden = true;
    } catch (err) {
      const box = $("load-error");
      box.textContent = "Could not refresh (" + err.message + "). Showing last loaded values.";
      box.hidden = false;
    } finally {
      main.dataset.loading = "false";
      nextRefresh = Date.now() + REFRESH_MS;
    }
  }

  $("refresh").addEventListener("click", load);
  setInterval(load, REFRESH_MS);
  load();
})();
