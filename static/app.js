/* Stocks Dashboard client: fetch /api/dashboard, render KPIs, charts, table, news. */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const main = $("main");
  const tooltip = $("tooltip");
  const REFRESH_MS = 5 * 60 * 1000;

  const fmtUSD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const fmtUSD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const fmtQty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

  function money(value, formatter) {
    return value === null || value === undefined ? "—" : (formatter || fmtUSD).format(value);
  }
  function signed(value, formatter) {
    if (value === null || value === undefined) return "—";
    const f = formatter || fmtUSD;
    return (value >= 0 ? "+" : "−") + f.format(Math.abs(value));
  }
  function signedPct(value, digits) {
    if (value === null || value === undefined) return "";
    return (value >= 0 ? "+" : "−") + Math.abs(value).toFixed(digits === undefined ? 2 : digits) + "%";
  }
  function updown(value) { return value >= 0 ? "up" : "down"; }
  function arrow(value) { return value >= 0 ? "▲" : "▼"; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function timeAgo(epoch) {
    if (!epoch) return "";
    const mins = Math.round((Date.now() / 1000 - epoch) / 60);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.round(hrs / 24) + "d ago";
  }

  // ---- tooltip -------------------------------------------------------------

  function showTooltip(evt, html) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const pad = 14;
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
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

  // ---- KPI tiles -----------------------------------------------------------

  function renderKpis(portfolio) {
    const t = portfolio.totals;
    $("kpi-total").textContent = fmtUSD.format(t.market_value);
    const td = $("kpi-total-delta");
    td.innerHTML = `<span class="${updown(t.day_change)}">${arrow(t.day_change)} ${signed(t.day_change)} (${signedPct(t.day_change_pct)})</span> today`;

    $("kpi-day").textContent = signed(t.day_change);
    $("kpi-day").className = "tile-value " + updown(t.day_change);
    $("kpi-day-delta").innerHTML = `<span class="${updown(t.day_change)}">${signedPct(t.day_change_pct)}</span> vs yesterday`;

    $("kpi-unreal").textContent = signed(t.unrealized_pl);
    $("kpi-unreal").className = "tile-value " + updown(t.unrealized_pl);
    $("kpi-unreal-delta").innerHTML = `<span class="${updown(t.unrealized_pl)}">${signedPct(t.unrealized_pl_pct)}</span> on ${fmtUSD0.format(t.cost_basis)} cost`;

    const movers = portfolio.positions.filter((p) => p.day_change_pct !== null);
    if (movers.length) {
      const top = movers.reduce((a, b) =>
        Math.abs(b.day_change_pct) > Math.abs(a.day_change_pct) ? b : a);
      $("kpi-mover").textContent = top.symbol;
      $("kpi-mover-delta").innerHTML =
        `<span class="${updown(top.day_change_pct)}">${arrow(top.day_change_pct)} ${signedPct(top.day_change_pct)}</span> (${signed(top.day_change)})`;
    }
  }

  // ---- charts (inline SVG) -------------------------------------------------

  const CHART = { labelW: 52, valueW: 74, barH: 18, rowH: 27, pad: 6 };

  function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  /* Horizontal bar chart, one hue (series-1), 4px rounded data-end,
     symbol labels left, value labels outside the bar end. */
  function renderAllocation(allPositions) {
    const host = $("chart-allocation");
    host.textContent = "";
    const valued = allPositions.filter((p) => p.market_value > 0);
    const total = valued.reduce((s, p) => s + p.market_value, 0);
    const TOP = 12;
    let positions = valued.slice(0, TOP);
    const tail = valued.slice(TOP);
    if (tail.length) {
      positions = positions.concat([{
        symbol: "Other",
        market_value: tail.reduce((s, p) => s + p.market_value, 0),
        quantity: null,
        price: null,
        other_count: tail.length,
      }]);
    }
    const W = 560;
    const H = positions.length * CHART.rowH + CHART.pad * 2;
    const plotW = W - CHART.labelW - CHART.valueW;
    const max = Math.max(...positions.map((p) => p.market_value));
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "Allocation by market value, largest first" });

    positions.forEach((p, i) => {
      const y = CHART.pad + i * CHART.rowH;
      const w = Math.max(2, (p.market_value / max) * plotW);
      const g = svgEl("g", {});
      const label = svgEl("text", { x: CHART.labelW - 8, y: y + CHART.barH - 4, "text-anchor": "end", class: "bar-label" });
      label.textContent = p.symbol;
      const bar = svgEl("path", { fill: "var(--series-1)",
        d: roundedRightRect(CHART.labelW, y, w, CHART.barH, 4) });
      const value = svgEl("text", { x: CHART.labelW + w + 6, y: y + CHART.barH - 4, class: "bar-value" });
      value.textContent = fmtUSD0.format(p.market_value);
      // invisible full-row hit target so hover is easy
      const hit = svgEl("rect", { x: 0, y: y - 2, width: W, height: CHART.rowH, fill: "transparent" });
      attachTip(hit, () =>
        `<div class="tt-title">${esc(p.symbol)}</div>` +
        `<div class="tt-row">${fmtUSD.format(p.market_value)} · ${(p.market_value / total * 100).toFixed(1)}% of portfolio</div>` +
        (p.other_count
          ? `<div class="tt-row">${p.other_count} smaller positions — see table</div>`
          : `<div class="tt-row">${fmtQty.format(p.quantity)} sh @ ${money(p.price)}</div>`));
      g.append(label, bar, value, hit);
      svg.append(g);
    });
    svg.append(svgEl("line", { x1: CHART.labelW, y1: CHART.pad - 2, x2: CHART.labelW, y2: H - CHART.pad + 2, class: "axis-line" }));
    host.append(svg);
  }

  /* Diverging bar chart around a zero baseline: gains right (status good),
     losses left (status critical). Value labels at the bar ends. */
  function renderDayChange(positions) {
    const host = $("chart-daychange");
    host.textContent = "";
    let rows = positions.filter((p) => p.day_change_pct !== null)
      .slice().sort((a, b) => b.day_change_pct - a.day_change_pct);
    if (!rows.length) { host.textContent = "No live quotes right now."; return; }
    let note = "";
    if (rows.length > 16) {
      const shown = rows.slice(0, 8).concat(rows.slice(-8));
      note = `Biggest movers — ${rows.length - shown.length} quieter holdings in the table below.`;
      rows = shown;
    }
    const W = 560;
    const H = rows.length * CHART.rowH + CHART.pad * 2;
    const valueW = 64;
    const plotW = (W - CHART.labelW - valueW * 2);
    const cx = CHART.labelW + valueW + plotW / 2;
    const max = Math.max(...rows.map((p) => Math.abs(p.day_change_pct)), 0.01);
    const scale = (plotW / 2 - 8) / max;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "Today's percent change per holding, gains and losses around zero" });

    rows.forEach((p, i) => {
      const y = CHART.pad + i * CHART.rowH;
      const w = Math.max(2, Math.abs(p.day_change_pct) * scale);
      const gain = p.day_change_pct >= 0;
      const g = svgEl("g", {});
      const label = svgEl("text", { x: CHART.labelW - 8, y: y + CHART.barH - 4, "text-anchor": "end", class: "bar-label" });
      label.textContent = p.symbol;
      const bar = svgEl("path", {
        fill: gain ? "var(--bar-up)" : "var(--bar-down)",
        d: gain ? roundedRightRect(cx, y, w, CHART.barH, 4)
                : roundedLeftRect(cx - w, y, w, CHART.barH, 4),
      });
      const value = svgEl("text", {
        x: gain ? cx + w + 6 : cx - w - 6,
        y: y + CHART.barH - 4,
        "text-anchor": gain ? "start" : "end",
        class: "bar-value",
      });
      value.textContent = signedPct(p.day_change_pct);
      const hit = svgEl("rect", { x: 0, y: y - 2, width: W, height: CHART.rowH, fill: "transparent" });
      attachTip(hit, () =>
        `<div class="tt-title">${esc(p.symbol)} ${arrow(p.day_change_pct)} ${signedPct(p.day_change_pct)}</div>` +
        `<div class="tt-row">${signed(p.day_change)} today · now ${fmtUSD.format(p.price)}</div>`);
      g.append(label, bar, value, hit);
      svg.append(g);
    });
    svg.append(svgEl("line", { x1: cx, y1: CHART.pad - 2, x2: cx, y2: H - CHART.pad + 2, class: "axis-line" }));
    host.append(svg);
    if (note) {
      const p = document.createElement("p");
      p.className = "chart-note";
      p.textContent = note;
      host.append(p);
    }
  }

  function roundedRightRect(x, y, w, h, r) {
    r = Math.min(r, w);
    return `M${x},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} Z`;
  }
  function roundedLeftRect(x, y, w, h, r) {
    r = Math.min(r, w);
    return `M${x + w},${y} v${h} h-${w - r} a${r},${r} 0 0 1 -${r},-${r} v-${h - 2 * r} a${r},${r} 0 0 1 ${r},-${r} Z`;
  }

  function sparkline(values) {
    if (!values || values.length < 2) return "";
    const W = 90, H = 26, pad = 2;
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const step = (W - pad * 2) / (values.length - 1);
    const pts = values.map((v, i) =>
      `${(pad + i * step).toFixed(1)},${(H - pad - ((v - min) / span) * (H - pad * 2)).toFixed(1)}`);
    return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="M${pts.join(" L")}"/></svg>`;
  }

  // ---- holdings table ------------------------------------------------------

  function renderTable(portfolio) {
    const tbody = $("holdings").querySelector("tbody");
    const tfoot = $("holdings").querySelector("tfoot");
    const t = portfolio.totals;
    tbody.innerHTML = portfolio.positions.map((p) => `
      <tr>
        <td class="sym">${esc(p.symbol)}${p.live ? "" : '<span class="stale-dot" title="No live quote; using last stored price">○ stale</span>'}</td>
        <td class="num">${fmtQty.format(p.quantity)}</td>
        <td class="num">${money(p.avg_buy_price)}</td>
        <td class="num">${money(p.price)}</td>
        <td class="num ${updown(p.day_change_pct || 0)}">${p.day_change_pct === null ? "—" : arrow(p.day_change_pct) + " " + signedPct(p.day_change_pct)}</td>
        <td class="num">${money(p.market_value)}</td>
        <td class="num ${p.unrealized_pl === null ? "" : updown(p.unrealized_pl)}">${signed(p.unrealized_pl)}</td>
        <td class="num ${p.unrealized_pl === null ? "" : updown(p.unrealized_pl)}">${p.unrealized_pl_pct === null ? "—" : signedPct(p.unrealized_pl_pct, 1)}</td>
        <td>${sparkline(p.spark)}</td>
      </tr>`).join("");
    tfoot.innerHTML = `
      <tr>
        <td>Total</td><td></td><td></td><td></td>
        <td class="num ${updown(t.day_change)}">${signedPct(t.day_change_pct)}</td>
        <td class="num">${fmtUSD.format(t.market_value)}</td>
        <td class="num ${updown(t.unrealized_pl)}">${signed(t.unrealized_pl)}</td>
        <td class="num ${updown(t.unrealized_pl)}">${signedPct(t.unrealized_pl_pct, 1)}</td>
        <td></td>
      </tr>`;
    $("holdings-asof").textContent = portfolio.market_time
      ? "prices as of " + new Date(portfolio.market_time * 1000).toLocaleString()
      : (portfolio.as_of ? "as of " + portfolio.as_of : "");
  }

  // ---- news ----------------------------------------------------------------

  function renderNews(listEl, items, showTicker) {
    listEl.innerHTML = items.map((n) => `
      <li>
        ${showTicker && n.ticker ? `<span class="news-ticker">${esc(n.ticker)}</span>` : ""}
        <div>
          <a class="news-title" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>
          <span class="news-meta">${esc(n.source)}${n.published ? " · " + timeAgo(n.published) : ""}</span>
        </div>
      </li>`).join("") || "<li>No headlines right now.</li>";
  }

  // ---- load ----------------------------------------------------------------

  async function load() {
    main.dataset.loading = "true";
    try {
      const resp = await fetch("/api/dashboard", { headers: { Accept: "application/json" } });
      if (resp.status === 401) { window.location.href = "/login"; return; }
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      renderKpis(data.portfolio);
      renderAllocation(data.portfolio.positions);
      renderDayChange(data.portfolio.positions);
      renderTable(data.portfolio);
      renderNews($("news-portfolio"), data.news.portfolio, true);
      renderNews($("news-market"), data.news.market, false);
      $("updated").textContent = "Updated " + new Date(data.generated_at * 1000).toLocaleTimeString();
      $("load-error").hidden = true;
    } catch (err) {
      const box = $("load-error");
      box.textContent = "Could not refresh data (" + err.message + "). Showing last loaded values.";
      box.hidden = false;
    } finally {
      main.dataset.loading = "false";
    }
  }

  $("refresh").addEventListener("click", load);
  setInterval(load, REFRESH_MS);
  load();
})();
