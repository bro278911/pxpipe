// Server-rendered HTML dashboard — htmx polls fragments, Alpine drives the toast tray.
// Presentation only; server code (src/dashboard.ts, src/node.ts) needs no edits.

import { HTMX_JS, ALPINE_JS } from './vendor.js';
import { CACHE_CREATE_RATE, CACHE_READ_RATE } from '../core/baseline.js';
import type {
  StatsPayload,
  RecentPayload,
  RecentRow,
  SessionsPayload,
  SessionRow,
  FullStatsPayload,
  CurrentSessionPayload,
} from './types.js';

// ---- helpers --------------------------------------------------------

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function numFmt(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

/** "12.3k" / "1.2M" compact formatter for headline numbers. */
function kFmt(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1) + 'M';
  if (a >= 1000) return (v / 1000).toFixed(a >= 100_000 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function formatDuration(s: number): string {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + 'h ' : '') + (m || h ? m + 'm ' : '') + sec + 's';
}

function shortPath(p: string | null | undefined): string {
  if (!p) return '-';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

// ---- compression toggle (kill switch) ------------------------------------

export function renderToggleFragment(enabled: boolean): string {
  // NOTE:「直通模式」「關閉壓縮」「啟用壓縮」為測試斷言字串。
  const banner = enabled
    ? ''
    : `<div class="banner"><strong>直通模式</strong> — 壓縮已關閉。每個請求都原封不動送到 Claude：不轉圖、不省 token。適合用來 A/B 對照，或上游 API 出狀況時暫時停用。</div>`;
  // Button POSTs the OPPOSITE of current state; 2s poll keeps it fresh.
  const confirm = enabled
    ? ` hx-confirm="要關閉壓縮嗎？\n\n請求會原封不動直接送往 Claude。重新啟動 proxy 後會自動恢復開啟。"`
    : '';
  return (
    banner +
    `<div class="switch">` +
    `<span class="switch-state ${enabled ? 'on' : 'off'}"><span class="switch-dot"></span>${enabled ? '壓縮開啟中' : '壓縮已關閉'}</span>` +
    `<button class="switch-btn" type="button" hx-post="/fragments/toggle" hx-target="#frag-toggle" hx-vals='{"enabled": ${!enabled}}'${confirm}>` +
    (enabled ? '關閉壓縮' : '啟用壓縮') +
    `</button>` +
    `<span class="hint">緊急開關 · 重新啟動後自動恢復開啟</span>` +
    `</div>`
  );
}

// ---- compress scope (which models get imaged) ----------------------------

/** Chip catalog — UNION with env scope + active set, so env-var models stay toggleable. Labels are cosmetic. */
const MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
];

const GPT_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  { id: 'gpt-5.5', label: 'GPT 5.5' },
];

const GROK_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'grok-4.5', label: 'Grok 4.5' },
];

const GEMINI_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
];

export function renderModelsFragment(
  active: string[],
  configured: string[],
  enabled: boolean,
): string {
  const on = new Set(active);
  const labelOf = new Map(
    [...MODEL_CATALOG, ...GPT_MODEL_CATALOG, ...GROK_MODEL_CATALOG, ...GEMINI_MODEL_CATALOG].map((m) => [m.id, m.label]),
  );
  // Union the catalog with env-configured + active ids so PXPIPE_MODELS-enabled
  // families always show as toggles, then split into chip rows (Claude /
  // OpenAI Responses / Gemini) plus the PXPIPE_MODELS CSV textbox that mirrors the scope.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...MODEL_CATALOG.map((m) => m.id),
    ...GPT_MODEL_CATALOG.map((m) => m.id),
    ...GROK_MODEL_CATALOG.map((m) => m.id),
    ...GEMINI_MODEL_CATALOG.map((m) => m.id),
    ...configured,
    ...active,
  ]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const chipFor = (id: string): string => {
    const lit = on.has(id);
    const label = labelOf.get(id) ?? id;
    return (
      `<button class="chip${lit ? ' on' : ''}" type="button" ` +
      `hx-post="/fragments/models" hx-target="#frag-models" ` +
      `hx-vals='${escapeHtml(`{"model":${JSON.stringify(id)},"on":${!lit}}`)}'>${escapeHtml(label)}${lit ? ' ✓' : ''}</button>`
    );
  };
  const claudeChips = ids.filter((id) => id.startsWith('claude')).map(chipFor).join('');
  const geminiChips = ids.filter((id) => id.includes('gemini')).map(chipFor).join('');
  const gptChips = ids.filter((id) => id.startsWith('gpt')).map(chipFor).join('');
  const grokChips = ids.filter((id) => id.startsWith('grok')).map(chipFor).join('');
  const otherChips = ids
    .filter((id) => !id.startsWith('claude') && !id.startsWith('gpt') && !id.startsWith('grok') && !id.includes('gemini'))
    .map(chipFor)
    .join('');
  const moot = enabled
    ? ''
    : `<div class="models"><span class="hint">壓縮已關閉 — 這些設定目前不會生效</span></div>`;
  return (
    moot +
    `<div class="models">` +
    `<span class="models-label">轉圖的 Claude 模型</span>` +
    claudeChips +
    `<span class="hint">未列出的模型一律走純文字</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">轉圖的 Gemini 模型</span>` +
    geminiChips +
    `<span class="hint">預設啟用 · 100/100 視覺讀取</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">轉圖的 OpenAI Responses 模型</span>` +
    gptChips +
    grokChips +
    otherChips +
    `<span class="hint">需手動開啟 · 不支援 Anthropic cache_control</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">PXPIPE_MODELS</span>` +
    `<input class="models-csv" id="models-csv" type="text" name="list" ` +
    `value="${escapeHtml(active.join(','))}" spellcheck="false" autocomplete="off" ` +
    `hx-post="/fragments/models" hx-target="#frag-models" hx-trigger="change">` +
    `<span class="hint">模型 base 的 CSV，或填 off · 按 Enter 或離開欄位即套用 · 需匯出才會保存</span>` +
    `</div>`
  );
}

// ---- session hero --------------------------------------------------------

// Must stay in lockstep with ASSUMED_INPUT_USD_PER_MTOK in src/dashboard.ts.
const INPUT_USD_PER_MTOK = 10.0;
void INPUT_USD_PER_MTOK; // suppress unused-var; renderHeaderFragment uses the server's pricing block.

// Lifetime hero. Reads the SAME cumulative weighted totals as the header strip
// (serveStats), so the headline and the "$ saved" tiles can never disagree, and
// the number stops swinging on tiny per-session samples. Cache-weighted on
// purpose ("lifeweight"): it answers "did pxpipe move my real, cache-discounted
// bill since this proxy started", not a raw token count.
export function renderSessionSummaryFragment(s: StatsPayload): string {
  const measured = s.compressed_requests ?? 0;
  if (measured <= 0) {
    return (
      `<div class="hero hero-empty">` +
      `<div class="hero-eyebrow">自啟動以來</div>` +
      `<div class="hero-headline">暖機中…</div>` +
      `<div class="hero-sub">用 <code>ANTHROPIC_BASE_URL</code> 把 Claude Code 指向這個 proxy，或改用 <code>pxpipe warp -- claude</code> 啟動，讓 <code>/remote-control</code> 與 claude.ai 連接器維持正常。送出一則訊息後，累計節省量就會顯示在這裡。</div>` +
      `</div>`
    );
  }
  // Cache-aware reduction — same basis as the Details panel + Saved column.
  // Raw count_tokens would over-claim: most of the text baseline would have been
  // cheap cache-reads (~0.1×), not full-price tokens. Weighting both sides at their
  // real cache rate is the only comparison that can't contradict the Saved column.
  // Input-only: pxpipe never touches output, so lumping it in just dampened the %.
  const baselineW = s.baseline_input_weighted ?? 0; // same context as text, cache-aware
  const actualW = s.actual_input_weighted ?? 0; // what we actually sent, cache-aware
  const outMult = s.pricing_assumptions?.output_multiplier || 5;
  const rawOutput = (s.output_weighted ?? 0) / outMult; // reply — never compressed
  const inputPct = baselineW > 0 ? (1 - actualW / baselineW) * 100 : 0;
  const positive = inputPct >= 0;
  const bigNum = `${Math.abs(inputPct).toFixed(0)}%`;
  const word = positive ? '少用' : '多用';

  return (
    `<div class="hero${positive ? '' : ' hero-neg'}">` +
    `<div class="hero-eyebrow">自啟動以來 · 已轉圖 ${numFmt(measured)} 個請求</div>` +
    `<div class="hero-headline">${word} <span class="hero-num">${bigNum}</span> token</div>` +
    `<div class="hero-sub">` +
    `實際計費的輸入 token 為 <strong>${kFmt(actualW)}</strong>，同樣的脈絡若維持純文字則是 <strong>${kFmt(baselineW)}</strong>。` +
    `你最新的訊息與模型輸出永遠不會被壓縮。` +
    `</div>` +
    `<div class="hero-meta">` +
    `以供應商計費 token 為基準，可量測處已套用快取折扣 · ` +
    `輸出未經任何處理（${kFmt(rawOutput)}） · 不做金額假設` +
    `</div>` +
    `</div>`
  );
}

// ---- stat strip + "Show the math" drawer ----------------------------------

function mathRow(key: string, val: number | string | undefined, note = ''): string {
  const v = typeof val === 'number' ? numFmt(val) : String(val ?? '-');
  return `<div><span class="k">${key}:</span> <span class="v">${escapeHtml(v)}</span> <span class="k">${note}</span></div>`;
}

function mathBlock(title: string, body: string): string {
  return `<section class="math-block"><h4>${title}</h4><div class="formula">${body}</div></section>`;
}

/** Stat tile; `tip` adds a hover "?" explainer. */
function statTile(
  label: string,
  value: string,
  sub: string,
  cls = '',
  tip = '',
): string {
  const q = tip
    ? `<span class="q" tabindex="0" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}">?</span>`
    : '';
  return (
    `<div class="tile">` +
    `<div class="tile-label">${label}${q}</div>` +
    `<div class="tile-value ${cls}">${value}</div>` +
    `<div class="tile-sub">${sub}</div>` +
    `</div>`
  );
}

export function renderHeaderFragment(s: StatsPayload, port: number): string {
  const pa = s.pricing_assumptions;
  const unpricedImaged = Math.max(
    0,
    (s.compressed_requests ?? 0) - (s.compressed_paid_requests ?? 0),
  );
  const onlyUnpriced = unpricedImaged > 0 && (s.compressed_paid_requests ?? 0) === 0;

  // Compare the same imaged requests on both sides. Passthrough requests are
  // generally smaller because the profitability gate selected them, so their
  // average is not a valid "without pxpipe" counterfactual.
  const cAvg = s.compressed_avg_usd_per_request ?? 0;
  const paidImaged = s.compressed_paid_requests ?? 0;
  const withoutAvg = paidImaged > 0 ? cAvg + (s.saved_usd ?? 0) / paidImaged : 0;
  const costTile = paidImaged > 0
    ? statTile(
        '每次請求成本',
        `$${cAvg.toFixed(4)}`,
        `未使用 pxpipe 則為 $${withoutAvg.toFixed(4)}`,
        cAvg <= withoutAvg ? 'pos' : 'neg',
        '已計價轉圖請求的平均成本，對照同一批請求維持純文字（已計入快取折扣）的成本。未量測到的請求一律以零節省計算。',
      )
    : onlyUnpriced
      ? statTile(
          '每次請求成本',
          '—',
          '未設定此供應商的價格',
          'muted-val',
          '已有 token 節省量，但此供應商不納入以 Claude 價格換算的金額估算。',
        )
      : statTile(
        '每次請求成本',
        '收集中…',
        '等待第一筆已計價的轉圖請求',
        'muted-val',
        '等轉圖請求回傳供應商用量後，才會出現這項對照。',
      );

  const savedUsdTile = onlyUnpriced
    ? statTile(
        '估計省下金額',
        '—',
        '未設定此供應商的價格',
        'muted-val',
        'token 節省量會另外顯示。金額估算需要各供應商的專屬價格，不會用 Claude 費率推估。',
      )
    : statTile(
        '估計省下金額',
        `$${(s.saved_usd ?? 0).toFixed(2)}`,
        unpricedImaged > 0
          ? `已排除 ${numFmt(unpricedImaged)} 筆其他供應商計價的請求`
          : `以每百萬輸入 token $${pa.input_per_mtok} 的基準價計算`,
        '',
        '僅就符合目前價格假設的請求做快取感知估算，其他供應商仍排除在外。',
      );

  const strip =
    `<div class="strip">` +
    statTile('請求數', numFmt(s.requests), `其中 ${numFmt(s.compressed_requests)} 筆轉成圖片`) +
    statTile(
      '省下的輸入 token',
      numFmt(s.saved_input_tokens),
      '相較於同樣脈絡以純文字送出',
      'pos',
       '龐大的脈絡改用精簡圖片送出，而非純文字。採用供應商回報的輸入 token，並以實測或模型輪廓推估的純文字量做對照；最近幾輪對話與模型輸出維持文字。',
     ) +
    savedUsdTile +
    costTile +
    `</div>`;

  // math drawer
  const savedMath =
    `<div><span class="k">公式：</span> <span class="v">節省 = 基準 − 實際</span></div>` +
    `<div><span class="k">權重：</span> <span class="v">input×1.0, cache_write_5m×1.25, cache_write_1h×2.0, cache_read×0.10</span></div>` +
    `<div class="sp"></div>` +
    mathRow('基準', s.baseline_input_weighted, '（快取感知：可快取×權重 + 冷尾段）') +
    mathRow('實際', s.actual_input_weighted, '（input + cc_5m×1.25 + cc_1h×2.0 + cr×0.10）') +
    mathRow('節省', s.saved_input_tokens, `<span class="op">=</span> 基準 − 實際`) +
    `<span class="src">不含輸出 — 壓縮與否結果完全相同</span>`;

  const usdMath = onlyUnpriced
    ? `<div><span class="v">此供應商無法提供金額估算。</span></div>` +
      `<span class="src">token 節省量仍會照常回報；Claude 的價格不會套用到其他供應商。</span>`
    :
    `<div><span class="k">公式：</span> <span class="v">省下金額 = 節省 token 數 × $${pa.input_per_mtok}/Mtok</span></div>` +
    `<div class="sp"></div>` +
    mathRow('節省 token 數', s.saved_input_tokens, '（快取感知，輸入側）') +
    mathRow('省下金額', `$${(s.saved_usd || 0).toFixed(4)} `, `<span class="op">=</span> 節省 token 數 × 輸入單價 / 1e6`) +
    `<span class="src">來源：${escapeHtml(pa.source || 'docs.anthropic.com pricing')}</span>`;

  const costPerRequestMath =
    `<div><span class="k">公式：</span> <span class="v">未使用 pxpipe = 實際轉圖成本 + 實測節省</span></div>` +
    `<div><span class="k">為什麼：</span> <span class="v">兩邊的平均都涵蓋同一批已計費的轉圖請求。直通請求不列入計算，因為獲利門檻挑中的是另一群、通常較小的請求。</span></div>` +
    `<div class="sp"></div>` +
    mathRow(`實際轉圖 (n=${paidImaged})`, `$${(s.compressed_actual_usd || 0).toFixed(4)}`, `總計 · 平均 $${cAvg.toFixed(4)}/次`) +
    mathRow('實測節省', `$${(s.saved_usd || 0).toFixed(4)}`, '快取感知的輸入側總計') +
    mathRow('未使用 pxpipe', `$${withoutAvg.toFixed(4)}/次`, '<span class="op">=</span>（實際轉圖 + 實測節省）/ n') +
    `<span class="src">未量測到的轉圖請求仍計入 n 與實際成本，但節省量一律以零計算</span>`;

  const pctMath =
    `<div><span class="k">公式：</span> <span class="v">總支出占比 = 節省量 / (基準等價量 + 全部輸出 × ${pa.output_multiplier})</span></div>` +
    `<div><span class="k">這是診斷值，不是主打數字：</span> <span class="v">這是一個反事實推估（「你原本會付多少」）。它依賴 count_tokens 探測、快取感知拆分，以及輸入單價假設。適合當合理性檢查；真實流量的答案是上方的「壓縮 vs 直通」對比。</span></div>` +
    `<div class="sp"></div>` +
    mathRow('節省量', s.saved_input_tokens, '（已量測列的分子；快取感知）') +
    mathRow('基準等價量', s.all_baseline_equivalent_weighted, '（每一筆計費請求；已量測者取基準值，其餘取實際值）') +
    mathRow(`全部輸出 × ${pa.output_multiplier}`, s.all_output_weighted, '（每一筆計費請求）') +
    mathRow('總支出占比', (s.saved_pct_of_all_spend || 0).toFixed(1) + '%', `<span class="op">=</span> 節省量 / 反事實總量 × 100`) +
    mathRow('全部用量請求數', s.all_usage_requests, '（分母請求數 — 壓縮 + 直通 + 探測失敗）') +
    `<span class="src">分子為實測值，分母為全列反事實推估 — 上限為 100%</span>`;

  const tokeqMath =
    `<div><span class="k">公式：</span> <span class="v">token 等價量 = 輸入 + 輸出 × ${pa.output_multiplier}</span></div>` +
    `<div><span class="k">為什麼：</span> <span class="v">對應 Anthropic 每 Mtok 的價格比（輸入 $${pa.input_per_mtok} vs 輸出 $${pa.input_per_mtok * pa.output_multiplier}）— 週用量上限的計量方式就是這樣算的。</span></div>` +
    `<div class="sp"></div>` +
    mathRow('實際 token 等價量', s.actual_token_equivalent) +
    mathRow('基準 token 等價量', s.baseline_token_equivalent, `（未經 proxy 的反事實推估，輸出同樣 ×${pa.output_multiplier}）`) +
    `<div class="sp"></div>` +
    mathRow('含量測的事件數', s.events_with_measurement, '（SSE/JSON 掃描器有產出字元數的事件）') +
    mathRow('實測文字字元數', s.measured_text_chars, '') +
    mathRow('實測思考字元數', s.measured_thinking_chars, '') +
    mathRow('實測工具呼叫字元數', s.measured_tool_use_chars, '') +
    mathRow('實測遮蔽區塊數', s.measured_redacted_block_count, '（不透明的加密區塊 — 會計費但無法量測）') +
    `<span class="src">實際量測 — 未經推估</span>`;

  const drawer =
    `<details class="drawer" id="math-drawer">` +
    `<summary>顯示算式與誠實對帳</summary>` +
    `<div class="drawer-intro">上方每一個數字都來自同一份逐事件紀錄。這個 proxy 只會影響<em>輸入</em> token；輸出兩邊都照列，讓百分比維持誠實。</div>` +
    `<div class="math-grid">` +
    mathBlock('節省的輸入 token', savedMath) +
    mathBlock('節省的金額', usdMath) +
    mathBlock('每次轉圖請求成本', costPerRequestMath) +
    mathBlock('總支出占比（診斷值）', pctMath) +
    mathBlock('Token 等價量（週用量上限的計算基準）', tokeqMath) +
    `</div></details>`;

  // NOTE: tests assert the header fragment contains the port number.
  const updated = `<div class="updated"><span class="live-dot"></span>運行中 · 連接埠 ${port} · 已運行 ${formatDuration(s.uptime_sec)}</div>`;

  return strip + drawer + updated;
}

// ---- request x-ray (image vs text breakdown) -----------------------------

export interface ContextMapData {
  id: number; // first image id (matches recent-table link)
  baselineTokens: number; // RAW count_tokens as plain text (cache-blind; sub-line only)
  realInput: number; // RAW input + cache_create + cache_read (cache-blind)
  baselineInputEff: number; // cache-WEIGHTED baseline — what text would actually be billed
  actualInputEff: number; // cache-WEIGHTED actual — what the images were actually billed
  haveBaseline: boolean; // weighted pair is trustworthy (baseline probe resolved)
  cacheRead: number; // cache_read tokens this turn. >0 ⇒ the actual request hit cache.
  warm: boolean; // did the TEXT baseline's prefix read warm? Server-observed only:
  // true iff the actual request had cache_read > 0. This keeps the text baseline
  // on the same cache state as the image path; no wall-clock-only inference.
  output: number;
  imageCount: number;
  /** Image blocks the CLIENT sent. They spend from the provider's cap exactly
   *  like ours, so they explain a turn that compressed less than usual. */
  nativeImages?: number;
  /** Image blocks really on the wire. Lower than imageCount when the history
   *  collapse absorbed messages that already carried our images. */
  wireImages?: number;
  /** Imaging steps that degraded to text because the cap was full. */
  imageBudgetSkips?: number;
  baselineImagedTokens?: number;
  buckets: Partial<Record<string, number>>; // bucket → chars rendered to PNG
  imageIds: number[]; // image-ring ids for the gallery
  compressed: boolean;
  model?: string;
  responsesComposition?: {
    instructions: number; systemDeveloper: number; userAssistant: number;
    functionCalls: number; functionOutputs: number; reasoningEncrypted: number;
    compactionOpaque: number; toolsJson: number; other: number;
    totalLocal: number; imageParts: number;
    completedFunctionPairs?: number; recentNativeFunctionPairs?: number;
    oldFunctionPairs?: number; openFunctionCalls?: number;
    orphanFunctionOutputs?: number; malformedFunctionItems?: number;
    imageableFunctionCalls?: number; imageableFunctionOutputs?: number;
    collapsedFunctionPairs?: number; collapsedFunctionCalls?: number;
    collapsedFunctionOutputs?: number;
  };
  /** Difference between the provider text counterfactual and local o200k buckets.
   * Can include envelope, tokenizer, and server-side additions. */
  responsesUnexplainedTokens?: number;
  restored?: boolean; // rebuilt from JSONL after a restart — PNG thumbnails are gone
}

const CTXMAP_BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ['static_slab', '系統提示 + 工具說明'],
  ['reminder', 'System-reminder 區塊'],
  ['tool_result_prose', '工具結果 — 文章'],
  ['tool_result_log', '工具結果 — 日誌'],
  ['tool_result_json', '工具結果 — JSON'],
  ['history', '較早的對話輪次'],
];

/** Image-vs-text breakdown for one request. */
export function renderContextMapFragment(
  c: ContextMapData | undefined,
  history: ContextMapData[] = [],
  notFound = false,
): string {
  const isLatest = c !== undefined && c.id === (history.at(-1)?.id ?? -1);
  if (notFound) {
    return `<div class="ctxmap"><div class="empty-note">這筆請求的拆解已經不再保留 — 只有最近的請求才留著。請在較新的列上點<strong>詳情</strong>。</div></div>`;
  }
  if (!c || (c.baselineTokens <= 0 && c.imageCount <= 0)) {
    return `<div class="ctxmap"><div class="empty-note">在任一請求上點<strong>詳情</strong>，即可看到哪些部分轉成了圖片、哪些維持純文字。</div></div>`;
  }
  // Cache-aware billing-equivalent basis — identical to the recent row's
  // As-text / Sent / Saved/lost columns. These are not raw token counts; they apply
  // Anthropic's cache rates so create/read misses are visible in the comparison.
  // The two panels can never contradict each other. The raw
  // count_tokens ratio is cache-blind: it over-states savings whenever the
  // prefix would have been a cheap cache-read, so it must NOT drive the
  // headline. It survives only as a clarifying sub-line below.
  const showCompare = c.haveBaseline && c.baselineInputEff > 0;
  const base = c.baselineInputEff;
  const real = c.actualInputEff;
  const pct = showCompare ? Math.round((1 - real / base) * 100) : 0;
  const rawShrink = c.baselineTokens > 0 ? Math.round((1 - c.realInput / c.baselineTokens) * 100) : 0;
  const totalImagedChars = CTXMAP_BUCKETS.reduce((a, [key]) => a + (c.buckets[key] ?? 0), 0);

  const imgRows = CTXMAP_BUCKETS.map(([key, label]) => [label, c.buckets[key] ?? 0] as const)
    .filter(([, ch]) => ch > 0)
    .map(
      ([label, ch]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(ch)} 字元</span></div>`,
    )
    .join('');

  const rc = c.responsesComposition;
  const responseRows: ReadonlyArray<readonly [string, number]> = rc
    ? [
        ['指令（instructions）', rc.instructions],
        ['系統／開發者項目', rc.systemDeveloper],
        ['維持原生的使用者／助理文字', rc.userAssistant],
        ['原生工具 JSON', rc.toolsJson],
        ['函式呼叫', rc.functionCalls],
        ['函式輸出', rc.functionOutputs],
        ['舊的已結束配對中符合轉圖資格的函式輸出', rc.imageableFunctionOutputs ?? 0],
        ['本次請求實際轉成圖片的函式輸出', rc.collapsedFunctionOutputs ?? 0],
        ['推理／加密項目', rc.reasoningEncrypted],
        ['壓縮／不透明項目', rc.compactionOpaque],
        ['其他 Responses 項目', rc.other],
      ]
    : [];
  const responseBreakdown = rc
    ? `<div class="split-note" style="margin-top:12px"><strong>原始 Responses 組成（本機 o200k 推估）</strong></div>` +
      responseRows.filter(([, n]) => n > 0).map(([label, n]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(n)} tok</span></div>`,
      ).join('') +
      `<div class="ctx-row"><span class="ctx-lbl">可轉圖文字的基準量</span><span class="ctx-val">${kFmt(c.baselineImagedTokens ?? 0)} tok</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">已完成的工具配對（舊的／近期原生／已轉圖）</span><span class="ctx-val">${rc.completedFunctionPairs ?? 0}（${rc.oldFunctionPairs ?? 0} / ${rc.recentNativeFunctionPairs ?? 0} / ${rc.collapsedFunctionPairs ?? 0}）</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">維持原生的未結束呼叫</span><span class="ctx-val">${rc.openFunctionCalls ?? 0}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">原生影像區塊</span><span class="ctx-val">${rc.imageParts}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">本機無法解釋的供應商 token</span><span class="ctx-val">${kFmt(c.responsesUnexplainedTokens ?? 0)} tok</span></div>` +
      `<div class="split-note">此診斷只採用本機 o200k 計數，不會呼叫 Anthropic 的 /count_tokens。</div>`
    : '';

  const ids = c.imageIds ?? [];
  const modelLabel = c.model ? escapeHtml(c.model) : '模型';
  const gallery = ids.length
    ? `<div class="pages-title">已送出 ${ids.length} 頁圖片給 ${modelLabel} — 點任一頁可讀取其背後的原始文字：</div>` +
      `<div class="pages">` +
      ids
        .map(
          (id) =>
            `<img class="page" src="/proxy-latest-png?id=${id}" alt="第 ${id} 頁" loading="lazy" title="點擊可閱讀第 ${id} 頁背後的原始文字" onclick="ppPin(${id});ppSource(true)" onerror="this.classList.add('page-gone'); this.alt='第 ${id} 頁已從緩衝區過期';" />`,
        )
        .join('') +
      `</div>`
    : c.restored && c.imageCount > 0
      ? `<div class="pages-title">已送出 ${c.imageCount} 頁圖片 — proxy 重啟後縮圖已過期，上方拆解是依存檔紀錄重建的。</div>`
      : '';

  // Did the TEXT baseline's prefix read warm this turn? This follows the actual
  // request's observed cache state: cache_read > 0 means warm, cache_read === 0
  // means cold. No wall-clock-only counterfactual is credited.
  const warm = showCompare && c.warm;
  const google = c.model?.startsWith('gemini-') === true;
  const textNoun = warm ? '快取文字' : '純文字';
  // Raw count_tokens can grow (imaging bloated a short prompt), so say so rather
  // than rendering a nonsensical "shrank -36%".
  const rawPhrase =
    rawShrink >= 0 ? `原始內容縮小 ${rawShrink}%。` : `原始內容增加 ${-rawShrink}%。`;
  const headline = !showCompare
    ? `已送出 <strong>${kFmt(c.actualInputEff || c.realInput)}</strong> 個計費等價輸入 token`
    : pct >= 0
      ? google
        ? `<span class="ctx-big">${pct}%</span> 較小 — 純文字會計為 <strong>${kFmt(base)}</strong> 個輸入 token；圖片計為 <strong>${kFmt(real)}</strong>`
        : `<span class="ctx-big">${pct}%</span> 較小 — ${textNoun}會計費 <strong>${kFmt(base)}</strong> 個輸入 token；圖片實際計費 <strong>${kFmt(real)}</strong>`
      : google
        ? `<span class="ctx-big">${-pct}%</span> 較大 — 圖片計為 <strong>${kFmt(real)}</strong> 個輸入 token，純文字則為 <strong>${kFmt(base)}</strong>`
        : `<span class="ctx-big">${-pct}%</span> 較大 — 圖片計費 <strong>${kFmt(real)}</strong> 個輸入 token，${textNoun}則為 <strong>${kFmt(base)}</strong>`;
  // Clarifying sub-line. It must match the actual request's cache state: claiming
  // a 0.1× read discount when cache_read===0 would count hypothetical cache as a
  // pxpipe effect, so cold rows price both paths cold.
  const subnote = !showCompare
    ? '計費 token 已計入快取折扣（讀取以 0.1× 計）— 這次請求尚無可信的純文字基準。'
    : google
      ? `與「節省」欄採用相同的供應商 token 基準，差異來自 token 數量。${rawPhrase}`
    : !warm
      ? `本回合沒有溫熱的文字快取 — 純文字對照組的前綴以 1.25× 建立費率計價（與圖片路徑所付的是同一筆事件），基準與「節省」欄完全相同，差異純粹來自 token 數量。${rawPhrase}`
      : pct < 0 && rawShrink > 0
          ? `計費 = 套用快取折扣後（讀取以 0.1× 計），基準與「節省」欄相同。原始文字雖小 ${rawShrink}%，但其中多數本來就能便宜地走快取讀取 — 所以改成圖片反而更貴。`
          : `計費 = 套用快取折扣後（讀取以 0.1× 計），基準與「節省」欄相同。${rawPhrase}`;
  const title = isLatest ? '最新請求' : '選取的請求';

  // The provider caps a request at 100 image blocks and counts the CLIENT's
  // images against the same limit. Three facts are worth showing, and only when
  // they are true — a quiet turn should stay quiet:
  //   - the client brought its own images (they shrank our room),
  //   - we rendered more pages than we shipped (the collapse ate some),
  //   - we gave up on imaging something because the cap was full.
  const capBits: string[] = [];
  if ((c.nativeImages ?? 0) > 0) {
    capBits.push(`有 ${c.nativeImages} 張圖片來自你這端，同樣計入單次請求 100 張圖片的上限`);
  }
  if (c.wireImages !== undefined && c.wireImages < c.imageCount + (c.nativeImages ?? 0)) {
    const absorbed = c.imageCount + (c.nativeImages ?? 0) - c.wireImages;
    capBits.push(`有 ${absorbed} 頁已算繪的圖片未送出 — 歷史摺疊吸收了這些訊息（實際上線 ${c.wireImages} 張）`);
  }
  if ((c.imageBudgetSkips ?? 0) > 0) {
    capBits.push(`有 ${c.imageBudgetSkips} 個區塊因圖片額度已滿而維持純文字`);
  }
  const capNote = capBits.length
    ? `<div class="split-note cap-note">${capBits.map(escapeHtml).join(' · ')}</div>`
    : '';


  return (
    `<div class="ctxmap">` +
    `<div class="ctx-headline"><span class="ctx-title">${title}</span> ${headline}</div>` +
    `<div class="split-note ctx-subnote">${subnote}</div>` +
    `<div class="legend"><span class="tag tag-img">已轉為圖片</span><span class="tag tag-txt">維持純文字</span></div>` +
    `<div class="split">` +
    `<div class="split-col split-img">` +
    `<div class="split-head">壓縮成圖片 <span class="split-sum">${kFmt(totalImagedChars)} 字元 · ${c.imageCount} 頁</span></div>` +
    (imgRows || `<div class="ctx-row muted-row">這次請求沒有任何內容轉成圖片</div>`) +
    capNote +
    `<div class="split-note">pxpipe 可能誤讀圖片中的精確數值 — 請當作大意參考，而非逐位元精確。</div>` +
    `</div>` +
    `<div class="split-col split-txt">` +
    `<div class="split-head">維持純文字 <span class="split-sum">逐位元精確</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">你最新的訊息</span><span class="ctx-val">逐字保留</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">模型回覆（輸出）</span><span class="ctx-val">${kFmt(c.output)} token</span></div>` +
    `<div class="split-note">永不轉成圖片 — ID、雜湊與精確數字都安全。</div>` +
    `</div>` +
    `</div>` +
    responseBreakdown +
    gallery +
    `</div>`
  );
}

// ---- recent requests table -----------------------------------------------

function statusCls(status: number): string {
  if (status >= 500) return 'bad';
  if (status >= 400) return 'warn';
  return 'good';
}

export function renderRecentFragment(p: RecentPayload): string {
  const rows = (p.recent ?? []).slice().reverse();
  const body =
    rows.length === 0
      ? `<tr><td colspan="10" class="empty-cell">尚無請求 — 有流量時會即時出現在這裡。</td></tr>`
      : rows
          .map((e: RecentRow, i: number) => {
            const viewId = (e.img_ids ?? (e.img_id != null ? [e.img_id] : []))[0];
            const viewLink =
              viewId != null
                ? `<a class="row-view" href="#" hx-get="/fragments/context-map?req=${viewId}" hx-target="#frag-context-map" hx-swap="innerHTML">詳情 →</a>`
                : `<span class="muted">—</span>`;
            const saved = e.session_saved_so_far_delta;
            // A loss that disappears when the newly written prefix is repriced at
            // the read rate is just the one-time cache-create premium — the
            // purchase price of the cheap cache reads on the turns that follow.
            // Mark it so create turns don't read as gate failures.
            const cc = e.cache_create ?? 0;
            const createLoss =
              saved != null &&
              saved < 0 &&
              cc > 0 &&
              saved + cc * (CACHE_CREATE_RATE - CACHE_READ_RATE) > 0;
            const createNote = createLoss
              ? ` <span class="mk-create" title="快取建立回合：這筆損失是把 ${numFmt(cc)} 個 token 寫入快取所付的一次性 ${CACHE_CREATE_RATE}× 溢價。後續回合以 ${CACHE_READ_RATE}× 重讀該前綴，通常就能回本。">建立</span>`
              : '';
            const savedCell = saved == null
              ? `<td class="num muted">—</td>`
              : saved > 0
                ? `<td class="num pos">${numFmt(saved)}</td>`
                : saved < 0
                  ? `<td class="num neg">${numFmt(saved)}${createNote}</td>`
                  : `<td class="num">0</td>`;
            const imaged = e.cc_added
              ? `<span class="badge badge-img">圖片</span>`
              : `<span class="badge badge-txt">文字</span>`;
            return (
              `<tr>` +
              `<td class="muted">${i + 1}</td>` +
              `<td><span class="pill pill-${statusCls(e.status)}">${e.status}</span></td>` +
              `<td class="endp">${escapeHtml(shortPath(e.path))}</td>` +
              `<td>${e.model ? `<code>${escapeHtml(e.model)}</code>` : '<span class="muted">—</span>'}</td>` +
              `<td>${imaged}</td>` +
              `<td class="num">${e.cache_read != null ? numFmt(e.cache_read) : '—'}</td>` +
              `<td class="num">${e.baseline_input != null ? numFmt(e.baseline_input) : '—'}</td>` +
              `<td class="num">${e.actual_input != null ? numFmt(e.actual_input) : '—'}</td>` +
              savedCell +
              `<td class="num">${viewLink}</td>` +
              `</tr>`
            );
          })
          .join('');
  return (
    `<table class="rtable"><thead><tr>` +
    `<th>#</th>` +
    `<th>結果</th>` +
    `<th>端點</th>` +
    `<th>模型</th>` +
    `<th title="這次請求的脈絡有被壓成圖片嗎？">送出形式</th>` +
    `<th class="num" title="供應商回報由快取提供的 token">快取命中</th>` +
    `<th class="num" title="若維持純文字送出、套用快取建立／讀取費率後的等價計費輸入量">純文字時</th>` +
    `<th class="num" title="改用圖片後、套用快取建立／讀取費率後的實際等價計費輸入量">實際送出</th>` +
    `<th class="num" title="純文字時減去實際送出；負值代表改用圖片反而更貴">省下／多花</th>` +
    `<th></th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

// ---- image ↔ source inspector --------------------------------------------

export interface LatestFragmentInput {
  payload: RecentPayload;
  pin: number | null; // pinned image id, or null to follow latest
  showSource: boolean;
  sourceText: string | null; // null = not captured
}

export function renderLatestFragment(inp: LatestFragmentInput): string {
  const { payload, pin, showSource, sourceText } = inp;
  const hasPreview = payload.has_preview === true;
  const meta = payload.preview_meta ?? '';
  const imageIds = payload.image_ids ?? [];
  const pinnedEvicted = pin != null && !imageIds.includes(pin);

  // Pinned id, or latest (cache-busted by meta).
  const imgSrc =
    pin != null
      ? `/proxy-latest-png?id=${pin}`
      : `/proxy-latest-png?t=${encodeURIComponent(meta)}`;

  const pinBar =
    pin != null
      ? `<div class="viewer-bar"><button class="mini-btn" type="button" onclick="ppPin(null)">← 回到最新一張</button><span class="mini-label">圖片 #${pin}</span></div>`
      : '';

  let main: string;
  if (pin != null && pinnedEvicted) {
    main = `<div class="evicted">圖片 #${pin} 已不在緩衝區內</div>`;
  } else if (pin != null || hasPreview) {
    // When source pane is open the image appears inside the pairing — don't duplicate it.
    main = showSource ? '' : `<div class="frame"><img src="${imgSrc}" alt="算繪後的頁面" /></div>`;
  } else {
    main = `<div class="empty-note">目前還沒有圖片 — pxpipe 一壓縮請求就會出現在這裡。</div>`;
  }

  const showBtn = pin != null ? !pinnedEvicted : hasPreview;
  const caption =
    pin != null ? `圖片 #${pin}` : meta ? `${escapeHtml(meta)} · 左上角以原始尺寸顯示` : '';
  const srcBtn = showBtn
    ? `<button class="mini-btn" type="button" onclick="ppSource(${showSource ? 'false' : 'true'})">${showSource ? '隱藏原始文字' : '顯示這張圖背後的文字'}</button>`
    : '';

  let pane = '';
  if (showSource) {
    pane =
      sourceText == null
        ? `<div class="evicted">這張圖沒有留存原始文字</div>`
        : `<div class="pairing">` +
          `<div class="pair-col"><div class="pair-head pair-img">模型看到的內容 · 圖片</div><div class="frame frame-sm"><img src="${imgSrc}" alt="算繪後的頁面" /></div></div>` +
          `<div class="pair-mid">來源 ↓</div>` +
          `<div class="pair-col"><div class="pair-head pair-txt">原始文字 · 逐位元完全相同</div><pre class="src-pane">${escapeHtml(sourceText)}</pre></div>` +
          `</div>`;
  }

  return pinBar + main + `<div class="viewer-caption">${caption} ${srcBtn}</div>` + pane;
}

// ---- sessions bar chart --------------------------------------------------

const TOP_N = 8;

export function renderSessionsFragment(p: SessionsPayload): string {
  const all = p.sessions ?? [];
  const rows = [...all]
    .sort((a, b) => (b.tokensSavedEst ?? 0) - (a.tokensSavedEst ?? 0))
    .slice(0, TOP_N);
  const max = rows.reduce((m, s) => Math.max(m, s.tokensSavedEst ?? 0), 0);

  const label = (s: SessionRow) => {
    const proj = s.claudeCode?.projectPath || s.project;
    return proj ? shortPath(proj) : s.id.slice(0, 8);
  };
  const barPct = (v: number) => (max <= 0 || v <= 0 ? 0 : (v / max) * 100);

  const status = `<div class="status">已追蹤 ${all.length} 個 session</div>`;
  if (rows.length === 0) return status + `<div class="empty">目前還沒有 session。</div>`;

  const chart = rows
    .map((s) => {
      const v = s.tokensSavedEst ?? 0;
      const pct = barPct(v);
      const fill = pct > 0 ? `<div class="bar-fill" style="width:max(3px,${pct}%)"></div>` : '';
      return (
        `<div class="bar-row">` +
        `<div class="bar-label" title="${escapeHtml(s.claudeCode?.projectPath || s.project || s.id)}">${escapeHtml(label(s))}</div>` +
        `<div class="bar-track">${fill}</div>` +
        `<div class="bar-val${v < 0 ? ' neg' : ''}">${numFmt(v)}</div>` +
        `</div>`
      );
    })
    .join('');

  return (
    status +
    `<div class="bars">${chart}</div>` +
    `<div class="axis">各 session 省下的 token（快取感知） · 前 ${rows.length} 名 / 共 ${all.length} 個</div>`
  );
}

// ---- full-history stats table --------------------------------------------

export function renderStatsTableFragment(p: FullStatsPayload): string {
  if (p.error || !p.summary) {
    return `<div class="status">${escapeHtml(p.error || '無資料')}</div><table class="dtable"><tbody></tbody></table>`;
  }
  const s = p.summary;
  const totalIn = (s.inputTokensTotal || 0) + (s.cacheCreateTokensTotal || 0) + (s.cacheReadTokensTotal || 0);
  const hitRateTok = totalIn > 0 ? ((s.cacheReadTokensTotal / totalIn) * 100).toFixed(1) + '%' : '-';
  const hitRateEv =
    s.eventsWithUsage > 0 ? ((s.cacheHitEvents / s.eventsWithUsage) * 100).toFixed(1) + '%' : '-';
  const charRatio =
    s.origCharsTotal > 0 ? ((s.imageBytesTotal / s.origCharsTotal) * 100).toFixed(3) + 'x' : '-';

  // NOTE: the literal word "請求數" is asserted by tests.
  const tr = (k: string, v: string) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`;
  return (
    `<div class="status">從磁碟解析出 ${numFmt(p.parsed)} 筆事件</div>` +
    `<table class="dtable"><tbody>` +
    tr('請求數', numFmt(s.total)) +
    tr('2xx / 4xx / 5xx', `${numFmt(s.ok2xx)} / ${numFmt(s.err4xx)} / ${numFmt(s.err5xx)}`) +
    tr('已壓縮', numFmt(s.compressed)) +
    tr('直通', numFmt(s.passthrough)) +
    tr('輸入 token', numFmt(s.inputTokensTotal)) +
    tr('快取建立', numFmt(s.cacheCreateTokensTotal)) +
    tr('快取讀取', numFmt(s.cacheReadTokensTotal)) +
    tr('快取命中（依 token）', hitRateTok) +
    tr('快取命中（依事件）', hitRateEv) +
    tr('原始字元數', numFmt(s.origCharsTotal)) +
    tr('圖片位元組', numFmt(s.imageBytesTotal)) +
    tr('位元組 / 字元', charRatio) +
    (s.pinEvents
      ? tr(
          'pin 頁尾（未快取）',
          `${numFmt(s.pinCharsTotal ?? 0)} 字元 / ${numFmt(s.pinEvents)} 次請求`,
        )
      : '') +
    tr('延遲 p50 / p95', `${numFmt(s.durationP50)} / ${numFmt(s.durationP95)} ms`) +
    tr('首位元組 p50 / p95', `${numFmt(s.firstByteP50)} / ${numFmt(s.firstByteP95)} ms`) +
    `</tbody></table>`
  );
}

// ---- page shell -------------------------------------------------------------

// Favicon mirrors the .flame-dot glyph: a glossy flame sphere (radial highlight
// at 35%/30%, --flame -> --flame-strong) ringed by a faint --flame-tint halo.
// Inlined as a URL-encoded SVG data URI so the dashboard stays self-contained
// (no extra route/static asset). Keep colors in sync with :root in CSS below.
const FAVICON =
  "data:image/svg+xml," +
  "%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E" +
  "%3Cdefs%3E%3CradialGradient%20id='f'%20cx='35%25'%20cy='30%25'%20r='80%25'%3E" +
  "%3Cstop%20offset='0%25'%20stop-color='%23ffd0a8'/%3E" +
  "%3Cstop%20offset='55%25'%20stop-color='%23ff5a1f'/%3E" +
  "%3Cstop%20offset='100%25'%20stop-color='%23e8420a'/%3E" +
  "%3C/radialGradient%3E%3C/defs%3E" +
  "%3Ccircle%20cx='16'%20cy='16'%20r='15.5'%20fill='%23fff1ea'/%3E" +
  "%3Ccircle%20cx='16'%20cy='16'%20r='10'%20fill='url(%23f)'/%3E%3C/svg%3E";

const CSS = `
  :root {
    --bg: #faf6f2; --surface: #ffffff; --surface-2: #fbf4ee;
    --border: #efe5db; --border-strong: #e4d6c8;
    --ink: #241f1b; --ink-2: #5d534a; --muted: #9b9189;
    --flame: #ff5a1f; --flame-strong: #e8420a; --flame-ink: #bd3a08; --flame-tint: #fff1ea;
    --good: #1f9d57; --good-tint: #e7f6ee; --bad: #d8483b; --bad-tint: #fcebe9; --warn: #b7791f; --warn-tint: #fbf0db;
    --img: #ff5a1f; --img-ink: #bd3a08; --img-tint: #fff1ea;
    --txt: #2f7db0; --txt-ink: #1f5f8b; --txt-tint: #e9f3fb;
    --radius: 14px;
    --shadow: 0 1px 2px rgba(60,35,15,.05), 0 8px 24px rgba(60,35,15,.05);
    --mono: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color-scheme: light;
  }
  /* Dark theme: same warm-flame identity, inverted neutrals. Set before first
     paint by the <head> script (localStorage 'pp-theme' else system pref);
     toggled by ppTheme(). Accents (flame/img/txt) are lifted for contrast. */
  :root[data-theme="dark"] {
    --bg: #17120f; --surface: #211a15; --surface-2: #2a211b;
    --border: #352a22; --border-strong: #46382e;
    --ink: #f6efe8; --ink-2: #cabbac; --muted: #9a8c7d;
    --flame: #ff6a33; --flame-strong: #e8420a; --flame-ink: #ff9a63; --flame-tint: #3a2318;
    --good: #3fbd76; --good-tint: #15291f; --bad: #f0645a; --bad-tint: #341b18; --warn: #d99a3a; --warn-tint: #33260f;
    --img: #ff6a33; --img-ink: #ff9a63; --img-tint: #3a2318;
    --txt: #5aa3d6; --txt-ink: #8cc3ea; --txt-tint: #142631;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 28px rgba(0,0,0,.45);
    color-scheme: dark;
  }
  /* Dark fix-ups for the few intentionally hard-coded (light) spots. */
  :root[data-theme="dark"] .banner { border-color: #6e342c; color: #f4b9b1; }
  :root[data-theme="dark"] .banner strong { color: #ffd6cf; }
  :root[data-theme="dark"] .toast { box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 22px 26px 64px; background: var(--bg); color: var(--ink-2);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; }
  b, strong { color: var(--ink); }
  .good { color: var(--good); } .bad { color: var(--bad); }
  .muted { color: var(--muted); }

  /* topbar */
  .topbar { display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .flame-dot { width: 14px; height: 14px; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #ffd0a8, var(--flame) 55%, var(--flame-strong));
    box-shadow: 0 0 0 4px var(--flame-tint); flex: none; }
  .wordmark { font-size: 22px; font-weight: 800; color: var(--ink); letter-spacing: -0.02em; }
  .wordmark-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  /* Which machine is this? Two dashboards from two hosts look identical otherwise. */
  .hostchip { font-size: 11.5px; font-weight: 600; color: var(--muted); padding: 1px 7px;
    border: 1px solid var(--line); border-radius: 999px; white-space: nowrap; }
  .tagline { font-size: 12.5px; color: var(--muted); margin-top: 1px; max-width: 460px; }
  .controls { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }

  /* kill switch */
  .banner { display: block; margin: 0 0 8px; padding: 9px 13px; background: var(--bad-tint);
    border: 1px solid #f3b6af; border-radius: 9px; color: #9c2b20; font-size: 12px; max-width: 520px; }
  .banner strong { color: #8a2117; }
  .switch { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; justify-content: flex-end; }
  .switch-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
    padding: 3px 10px; border-radius: 999px; }
  .switch-state.on { color: var(--good); background: var(--good-tint); }
  .switch-state.off { color: var(--bad); background: var(--bad-tint); }
  .switch-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .switch-btn { background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong);
    padding: 6px 13px; cursor: pointer; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600;
    box-shadow: var(--shadow); }
  .switch-btn:hover { border-color: var(--flame); color: var(--flame-ink); }
  .hint { color: var(--muted); font-size: 11px; }
  .theme-btn { background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong);
    padding: 5px 11px; cursor: pointer; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600;
    box-shadow: var(--shadow); display: inline-flex; align-items: center; gap: 6px; line-height: 1; }
  .theme-btn:hover { border-color: var(--flame); color: var(--flame-ink); }

  /* model chips */
  .models { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 18px; }
  .models-label { color: var(--ink-2); font-size: 12px; font-weight: 600; }
  .models-csv { flex: 1 1 260px; min-width: 220px; color: var(--ink); background: var(--surface);
    border: 1px solid var(--border-strong); border-radius: 6px; padding: 4px 8px;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .models-csv:focus { outline: none; border-color: var(--flame-ink); }
  .models-routing { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 18px; }
  #routing-help { border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface);
    color: var(--ink); max-width: 600px; padding: 16px 20px; }
  #routing-help::backdrop { background: rgba(20, 12, 6, .4); }
  #routing-help h3 { margin: 0 0 8px; font-size: 14px; color: var(--ink); }
  #routing-help p, #routing-help li { font-size: 12px; line-height: 1.55; color: var(--ink-2); margin: 6px 0; }
  #routing-help ul { margin: 6px 0; padding-left: 18px; }
  #routing-help code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); }
  #routing-help pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; margin: 8px 0; overflow-x: auto;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); }
  .chip { background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong);
    border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 12px; }
  .chip:hover { border-color: var(--flame); color: var(--flame-ink); }
  .chip.on { background: var(--flame-tint); color: var(--flame-ink); border-color: var(--flame);
    font-weight: 600; }

  /* collapsed model-scope section (#116): the default compress scope is Fable 5
     only, so the three family rows stay hidden until the user opts in. The
     <details> wrapper lives in the static shell — NOT inside #frag-models —
     because the every-2s innerHTML poll would otherwise reset its open state. */
  .models-collapse { margin: 0 0 18px; }
  .models-collapse .models { margin: 0 0 10px; }
  .models-collapse .models:last-child { margin-bottom: 0; }
  .models-summary { cursor: pointer; color: var(--ink-2); font-size: 12px; font-weight: 600;
    margin: 0 0 8px; user-select: none; }
  .models-summary:hover { color: var(--flame-ink); }
  .models-warning { color: var(--ink-2); background: var(--surface); border: 1px solid var(--border-strong);
    border-left: 3px solid var(--bad); border-radius: 8px; padding: 8px 12px; font-size: 12px;
    margin: 0 0 12px; }

  /* session hero */
  #frag-session { display: block; margin-bottom: 16px; }
  .hero { background: linear-gradient(135deg, var(--flame-tint), var(--surface) 60%); border: 1px solid var(--border);
    border-left: 4px solid var(--flame); border-radius: var(--radius); padding: 20px 24px; box-shadow: var(--shadow); }
  .hero-neg { border-left-color: var(--bad); }
  .hero-eyebrow { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 8px; }
  .hero-headline { font-size: 28px; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; line-height: 1.1; }
  .hero-num { font-size: 56px; font-weight: 800; line-height: 1; margin-right: 8px;
    background: linear-gradient(135deg, #ff9a4d, var(--flame) 55%, var(--flame-strong));
    -webkit-background-clip: text; background-clip: text; color: transparent;
    font-variant-numeric: tabular-nums; }
  .hero-neg .hero-num { background: linear-gradient(135deg, #f0857a, var(--bad));
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .hero-sub { font-size: 14.5px; color: var(--ink-2); margin-top: 12px; max-width: 720px; }
  .hero-meta { font-size: 12px; color: var(--muted); margin-top: 10px; padding-top: 10px;
    border-top: 1px dashed var(--border-strong); }
  .hero-empty .hero-headline { color: var(--muted); font-size: 24px; }

  /* stat strip */
  .strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }
  @media (max-width: 1000px) { .strip { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 560px) { .strip { grid-template-columns: 1fr; } }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; box-shadow: var(--shadow); }
  .tile-label { font-size: 11.5px; font-weight: 600; color: var(--ink-2); margin-bottom: 8px;
    display: flex; align-items: center; gap: 5px; }
  .tile-value { font-size: 26px; font-weight: 800; color: var(--ink); font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em; line-height: 1.1; }
  .tile-value.pos { color: var(--good); } .tile-value.neg { color: var(--bad); }
  .tile-value.muted-val { color: var(--muted); font-size: 18px; font-weight: 600; }
  .tile-sub { font-size: 11.5px; color: var(--muted); margin-top: 6px; }
  .q { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px;
    border-radius: 50%; background: var(--surface-2); border: 1px solid var(--border-strong);
    color: var(--muted); font-size: 9px; font-weight: 700; cursor: help; position: relative; outline: none; }
  .q:hover, .q:focus-visible { color: var(--flame-ink); border-color: var(--flame); }
  .q::after { content: attr(data-tip); position: absolute; z-index: 50; left: 50%; bottom: calc(100% + 8px);
    width: min(280px, 75vw); transform: translate(-50%, 4px); padding: 8px 10px; border-radius: 7px;
    background: var(--ink); color: var(--surface); box-shadow: var(--shadow); font-size: 11px; font-weight: 500;
    line-height: 1.4; text-align: left; pointer-events: none; opacity: 0; visibility: hidden;
    transition: opacity .12s, transform .12s, visibility .12s; }
  .q::before { content: ''; position: absolute; z-index: 51; left: 50%; bottom: calc(100% + 3px);
    transform: translateX(-50%); border: 5px solid transparent; border-top-color: var(--ink);
    pointer-events: none; opacity: 0; visibility: hidden; transition: opacity .12s, visibility .12s; }
  .q:hover::after, .q:focus-visible::after { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
  .q:hover::before, .q:focus-visible::before { opacity: 1; visibility: visible; }

  /* drawer */
  .drawer { margin: 0 0 14px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
  .drawer > summary { cursor: pointer; user-select: none; list-style: none; padding: 12px 16px;
    font-size: 13px; font-weight: 600; color: var(--flame-ink); display: flex; align-items: center; gap: 8px; }
  .drawer > summary::-webkit-details-marker { display: none; }
  .drawer > summary::before { content: '▸'; color: var(--flame); font-size: 11px; }
  .drawer[open] > summary::before { content: '▾'; }
  .drawer > summary:hover { background: var(--surface-2); }
  .drawer-intro { padding: 0 16px 10px; font-size: 12px; color: var(--ink-2); }
  .drawer-intro em { color: var(--flame-ink); font-style: normal; font-weight: 600; }
  .math-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 0 16px 16px; }
  @media (max-width: 860px) { .math-grid { grid-template-columns: 1fr; } }
  .math-block h4 { margin: 0 0 6px; font-size: 12px; color: var(--ink); }
  .formula { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 9px 11px; font: 11px/1.55 var(--mono); color: var(--ink-2); white-space: pre-wrap;
    word-break: break-word; }
  .formula .k { color: var(--muted); } .formula .v { color: var(--ink); } .formula .op { color: var(--flame); }
  .formula .sp { height: 6px; }
  .formula .src { color: var(--muted); font-size: 10px; display: block; margin-top: 7px;
    border-top: 1px solid var(--border); padding-top: 6px; }
  .updated { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }

  /* sections */
  .section { margin-top: 26px; }
  .section-head { font-size: 14px; font-weight: 700; color: var(--ink); margin: 0 0 12px;
    display: flex; align-items: baseline; gap: 10px; }
  .section-sub { font-size: 12px; font-weight: 400; color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px 18px; box-shadow: var(--shadow); min-width: 0; }
  .card-head { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); margin: 0 0 12px; }
  .card-head.spaced { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border); }

  /* x-ray */
  .xray { display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; align-items: stretch; }
  /* 左欄高度不由自己的內容決定：卡片脫離文件流（absolute），列高改由右欄的
     「圖片與文字組成分析」決定，兩張卡片底部因此對齊，最近的請求清單再自行捲動。
     min-height 是右欄很短時的地板值，避免左欄被壓到只剩表頭。 */
  .xray-fit { position: relative; min-height: 320px; }
  .xray-fit > .card { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .xray-fit #frag-recent { flex: 1; min-height: 0; overflow-y: auto; }
  @media (max-width: 1000px) {
    .xray { grid-template-columns: 1fr; }
    /* 單欄時沒有可對齊的鄰居，改用視窗高度上限，維持同樣的「不跑版」效果。 */
    .xray-fit { position: static; min-height: 0; }
    .xray-fit > .card { position: static; }
    .xray-fit #frag-recent { max-height: 60vh; }
  }

  /* context map */
  .ctxmap { font-size: 13px; }
  .empty-note { color: var(--muted); font-size: 12.5px; padding: 14px; background: var(--surface-2);
    border: 1px dashed var(--border-strong); border-radius: 10px; }
  .ctx-headline { font-size: 13px; color: var(--ink-2); margin-bottom: 10px; }
  .ctx-title { display: inline-block; font-weight: 700; color: var(--ink); margin-right: 6px; }
  .ctx-big { font-size: 22px; font-weight: 800; color: var(--flame); font-variant-numeric: tabular-nums; }
  .legend { display: flex; gap: 8px; margin-bottom: 10px; }
  .tag { font-size: 11px; font-weight: 600; padding: 3px 9px 3px 22px; border-radius: 999px; position: relative; }
  .tag::before { content: ''; position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
    width: 8px; height: 8px; border-radius: 2px; }
  .tag-img { background: var(--img-tint); color: var(--img-ink); }
  .tag-img::before { background: var(--img); }
  .tag-txt { background: var(--txt-tint); color: var(--txt-ink); }
  .tag-txt::before { background: var(--txt); }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 560px) { .split { grid-template-columns: 1fr; } }
  .split-col { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--surface); }
  .split-img { border-top: 3px solid var(--img); background: linear-gradient(180deg, var(--img-tint), var(--surface) 40%); }
  .split-txt { border-top: 3px solid var(--txt); background: linear-gradient(180deg, var(--txt-tint), var(--surface) 40%); }
  .split-head { font-size: 12px; font-weight: 700; color: var(--ink); margin-bottom: 8px; display: flex;
    flex-direction: column; gap: 2px; }
  .split-sum { font-size: 10.5px; font-weight: 600; color: var(--muted); }
  .ctx-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; padding: 4px 0;
    border-bottom: 1px solid var(--border); }
  .ctx-row:last-of-type { border-bottom: none; }
  .ctx-lbl { color: var(--ink-2); } .ctx-val { color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted-row { color: var(--muted); font-style: italic; }
  .split-note { font-size: 10.5px; color: var(--muted); margin-top: 7px; }
  /* Cap notes explain a turn that compressed less than the user expects, so they
     must read as a reason, not as fine print. Warm tint, not an error colour —
     nothing here is broken. */
  .cap-note { color: var(--ink); border-left: 2px solid var(--flame); padding-left: 7px; }
  .pages-title { font-size: 11px; color: var(--ink-2); margin: 12px 0 6px; }
  .pages { display: flex; flex-wrap: wrap; gap: 6px; max-height: 320px; overflow: auto;
    background: var(--surface-2); padding: 6px; border: 1px solid var(--border); border-radius: 8px; }
  .page { height: 130px; width: auto; max-width: 230px; object-fit: contain; object-position: top left;
    image-rendering: pixelated; background: #fff; border: 1px solid var(--border-strong); border-radius: 4px;
    cursor: pointer; transition: border-color .12s, transform .12s; }
  .page:hover { border-color: var(--flame); transform: translateY(-1px); }
  .page.page-gone { width: 150px; height: 56px; background: var(--surface-2); border: 1px dashed var(--border-strong);
    color: var(--muted); font-size: 10px; cursor: default; }

  /* recent requests */
  .row-view { color: var(--flame-ink); font-weight: 600; text-decoration: none; cursor: pointer; white-space: nowrap; }
  .row-view:hover { text-decoration: underline; }
  table.rtable, table.dtable { width: 100%; border-collapse: collapse; font-size: 12px; }
  .rtable th, .dtable th { text-align: left; color: var(--muted); font-weight: 600; padding: 7px 8px;
    border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
  .rtable td, .dtable td { padding: 7px 8px; border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums; vertical-align: middle; color: var(--ink-2); }
  .rtable tr:last-child td, .dtable tr:last-child td { border-bottom: none; }
  .rtable tbody tr:hover, .rtable tbody tr:hover { background: var(--surface-2); }
  /* Keep wide tables inside their card: scroll horizontally rather than
     pushing the card border out. Fires only when the nowrap columns exceed
     the card width (narrow x-ray column / small window); no scrollbar when
     they fit. The table keeps width:100% so it fills at wide widths. */
  #frag-recent, #frag-stats { overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
  /* 卡片內捲時表頭要留在原地，否則捲到一半就看不出欄位意義 */
  .xray-fit #frag-recent thead th { position: sticky; top: 0; z-index: 1; background: var(--surface); }
  #frag-recent table, #frag-stats table { min-width: max-content; }
  #frag-latest { overflow: auto; scrollbar-width: thin; }
  th.num, td.num { text-align: right; }
  td.pos { color: var(--good); font-weight: 600; }
  td.neg { color: var(--bad); font-weight: 600; }
  .endp { color: var(--ink); font-family: var(--mono); font-size: 11px; }
  .empty-cell { color: var(--muted); text-align: center; padding: 18px; }
  .pill { display: inline-block; min-width: 38px; text-align: center; font-size: 11px; font-weight: 700;
    padding: 2px 8px; border-radius: 999px; font-variant-numeric: tabular-nums; }
  .pill-good { background: var(--good-tint); color: var(--good); }
  .pill-warn { background: var(--warn-tint); color: var(--warn); }
  .pill-bad { background: var(--bad-tint); color: var(--bad); }
  .badge { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
  .mk-create { font-size: 9.5px; font-weight: 700; color: var(--muted); border: 1px solid var(--muted);
    border-radius: 999px; padding: 0 5px; margin-left: 4px; vertical-align: 1px; cursor: help; white-space: nowrap; }
  .badge-img { background: var(--img-tint); color: var(--img-ink); }
  .badge-txt { background: var(--txt-tint); color: var(--txt-ink); }

  /* inspector */
  .viewer-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .mini-btn { font-size: 11px; background: var(--surface); color: var(--flame-ink); border: 1px solid var(--border-strong);
    border-radius: 7px; padding: 3px 9px; cursor: pointer; font-weight: 600; }
  .mini-btn:hover { border-color: var(--flame); }
  .mini-label { font-size: 11px; color: var(--muted); }
  .frame { background: #fff; border: 1px solid var(--border-strong); border-radius: 8px; padding: 5px;
    overflow: auto; max-height: 360px; scrollbar-width: thin; }
  .frame img { display: block; width: auto; height: auto; max-width: none; image-rendering: pixelated; }
  .frame-sm { max-height: 260px; }
  .viewer-caption { font-size: 11px; color: var(--muted); margin-top: 8px; display: flex; align-items: center;
    gap: 10px; flex-wrap: wrap; }
  .pairing { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 10px; }
  .pair-head { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 6px; display: inline-block;
    margin-bottom: 6px; }
  .pair-img { background: var(--img-tint); color: var(--img-ink); }
  .pair-txt { background: var(--txt-tint); color: var(--txt-ink); }
  .pair-mid { font-size: 11px; font-weight: 600; color: var(--muted); text-align: center; }
  .src-pane { margin: 0; max-height: 280px; overflow: auto; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 8px; padding: 9px; font: 11px/1.45 var(--mono);
    white-space: pre-wrap; word-break: break-word; color: var(--ink-2); }
  .evicted { font-size: 11.5px; color: var(--muted); padding: 12px; background: var(--surface-2);
    border: 1px dashed var(--border-strong); border-radius: 8px; }

  /* sessions bars */
  .status { margin-bottom: 12px; color: var(--muted); font-size: 12px; }
  .bars { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
  .bar-label { width: 150px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--ink); font-family: var(--mono); font-size: 11px; }
  .bar-track { flex: 1; min-width: 0; height: 16px; background: var(--surface-2); border-radius: 5px;
    overflow: hidden; border: 1px solid var(--border); }
  .bar-fill { height: 100%; border-radius: 5px 0 0 5px;
    background: linear-gradient(90deg, #ffa766, var(--flame)); }
  .bar-val { width: 78px; flex: none; text-align: right; font-variant-numeric: tabular-nums;
    color: var(--flame-ink); font-weight: 600; }
  .bar-val.neg { color: var(--bad); }
  .axis { margin-top: 12px; color: var(--muted); font-size: 11px; }
  .empty { text-align: center; color: var(--muted); padding: 22px; font-size: 12px; }

  /* toast tray */
  .tray { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px;
    z-index: 1000; pointer-events: none; }
  .toast { background: var(--surface); color: var(--bad); border: 1px solid #f0b3ab; border-radius: 9px;
    padding: 10px 14px; font-size: 12px; box-shadow: 0 8px 24px rgba(60,35,15,.14); display: flex;
    align-items: center; gap: 12px; pointer-events: auto; max-width: 360px; }
  .toast button { background: transparent; color: inherit; border: 0; cursor: pointer; font-size: 16px;
    line-height: 1; padding: 0; }
`;

// Client glue: window.pp (pin+source state) → hx-vals; preserves <details> open state across swaps; routes htmx errors to toast tray.
const GLUE_JS = `
  window.pp = { pin: null, src: false };
  function ppPin(id) {
    window.pp.pin = id;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  function ppSource(on) {
    window.pp.src = on;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  document.body.addEventListener('htmx:beforeSwap', function (ev) {
    const open = [];
    ev.detail.target.querySelectorAll('details[open][id]').forEach(function (d) { open.push(d.id); });
    ev.detail.target.__ppOpen = open;
  });
  document.body.addEventListener('htmx:afterSwap', function (ev) {
    (ev.detail.target.__ppOpen || []).forEach(function (id) {
      const d = document.getElementById(id);
      if (d) d.setAttribute('open', '');
    });
  });
  document.body.addEventListener('htmx:responseError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: ev.detail.xhr.status + ' ' + ev.detail.requestConfig.path }
    }));
  });
  document.body.addEventListener('htmx:sendError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: 'proxy unreachable: ' + ev.detail.requestConfig.path }
    }));
  });
`;

// Theme: light/dark via data-theme on <html>; saved in localStorage, defaults to system pref.
const THEME_JS = `
  (function () {
    function apply(t) {
      document.documentElement.dataset.theme = t;
      var b = document.getElementById('theme-btn');
      if (b) {
        b.textContent = t === 'dark' ? '☀ 亮色' : '☾ 暗色';
        b.setAttribute('aria-label', t === 'dark' ? '切換至亮色模式' : '切換至暗色模式');
      }
    }
    window.ppTheme = function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('pp-theme', next); } catch (e) {}
      apply(next);
    };
    apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  })();
`;

/** `hostLabel` names the machine this proxy runs on. The dashboard is otherwise
 *  byte-identical across hosts, so a tab opened against a remote host through
 *  the tailnet front is indistinguishable from the local one - which is how a
 *  session gets read on the wrong box. Empty label = render as before. */
export function renderPage(port: number, hostLabel = ''): string {
  const host = escapeHtml(hostLabel.trim());
  // hx-trigger="load, every Ns": paint on load then poll (2s live, 5s aggregates).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${host ? `${host} · pxpipe dashboard` : 'pxpipe — live dashboard'}</title>
<link rel="icon" href="${FAVICON}" />
<style>${CSS}</style>
<script>
  // Set theme before first paint (no flash): saved choice wins, else system preference.
  (function () {
    try {
      var s = localStorage.getItem('pp-theme');
      var dark = s ? s === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    } catch (e) { document.documentElement.dataset.theme = 'light'; }
  })();
</script>
</head>
<body>

<header class="topbar">
  <div class="brand">
    <span class="flame-dot"></span>
    <div>
      <div class="wordmark-row">
        <div class="wordmark">pxpipe</div>
        ${host ? `<span class="hostchip" title="proxy 主機">${host}</span>` : ''}
      </div>
      <div class="tagline">看清楚有哪些內容被轉成圖片，用來壓低你的 Claude Code 帳單。</div>
    </div>
  </div>
  <div class="controls">
    <button type="button" id="theme-btn" class="theme-btn" onclick="ppTheme()" aria-label="切換深色模式" title="切換深色／淺色模式">☾ 深色</button>
    <div id="frag-toggle" hx-get="/fragments/toggle" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
  </div>
</header>

<details class="models-collapse">
  <summary class="models-summary">接上你的 agent <span class="hint">warp 讓任何 CLI 透過這個 proxy 啟動 · pin 讓指示固定排在請求最後</span></summary>
  <p>warp 會直接把 proxy 接好再啟動 agent，不必改環境變數或設定檔：</p>
  <pre>pxpipe warp -- claude
pxpipe warp -- codex
pxpipe warp -- cursor-agent</pre>
  <p>別名也可以用（<code>pxpipe warp -- pp</code>）；<code>--route PATTERN=http://host:port</code> 可以加上 <code>api.anthropic.com</code> 以外的路由（PATTERN 若指定了埠號就只比對該埠，例如 <code>--route '127.0.0.1:9090/v1/*=http://127.0.0.1:${port}'</code> 可以接管指向另一個本機 proxy 的 agent）。不用 warp 的話，就自行把 agent 指向 <code>ANTHROPIC_BASE_URL=http://127.0.0.1:${port}</code>。</p>
  <p>在 session 內就能釘住指示 — 它們會被搬到每次請求的最後面，也就是模型真正會讀的位置：</p>
  <pre>@pxpipe pin 回答簡潔一點，不要長篇大論
@pxpipe unpin 2
@pxpipe unpin all</pre>
  <p><code>@pxpipe pin</code> 後面不接文字，就會列出目前釘住的內容。</p>
  <p>寫在全域或專案 <code>CLAUDE.md</code>（Codex / OpenCode 下為 <code>AGENTS.md</code>）裡的 <code>@pxpipe pin …</code> 也會照同樣方式搬移，每個 session 自動生效、不用手打。這類項目以檔案為準，所以 <code>unpin</code> 與 <code>unpin all</code> 都不會動到它們 — 要移除請直接改檔案。</p>
</details>

<details class="models-collapse">
  <summary class="models-summary">圖片壓縮適用模型 <span class="hint">預設為 Fable 5、Gemini 3.6 Flash 與 Gemini 3.7 Flash · 展開可試用其他模型家族</span></summary>
  <div class="models-warning">⚠ 圖片壓縮只在 Fable 5、Gemini 3.6 Flash 與 Gemini 3.7 Flash 上驗證過 — 其他家族可能反而<strong>更耗</strong> token。除非是刻意實驗，否則不建議開啟。</div>
  <div id="frag-models" hx-get="/fragments/models" hx-trigger="load, every 2s [!document.activeElement || document.activeElement.id !== 'models-csv']" hx-swap="innerHTML"></div>
  <div class="models-routing"><span class="hint">壓縮適用範圍 ≠ 供應商路由 — 非 Anthropic 的模型 ID 還需要在 proxy 上設定路由環境變數</span> <button class="mini-btn" type="button" onclick="document.getElementById('routing-help').showModal()">路由說明</button></div>
</details>

<dialog id="routing-help" onclick="if (event.target === this) this.close()">
  <h3>把 Claude Code 路由到 OpenAI / Cloudflare 模型</h3>
  <p>Claude 模型預設走 Anthropic。以下兩種路由可同時啟用，設定在 <strong>pxpipe 行程</strong>上（供應商憑證不必進 Claude Code）：</p>
  <ul>
    <li><code>OPENAI_MODELS</code> — 精確比對的模型 ID，路由到 OpenAI Responses（<code>OPENAI_UPSTREAM</code> + <code>OPENAI_API_KEY</code>）</li>
    <li><code>CLOUDFLARE_MODELS</code> — 精確比對的模型 ID，路由到 Cloudflare 的 OpenAI 相容端點（<code>CLOUDFLARE_ACCOUNT_ID</code> + <code>CLOUDFLARE_API_TOKEN</code>）</li>
  </ul>
  <p>同一個模型同時出現在兩份清單時，優先序為：<code>CLOUDFLARE_MODELS &gt; OPENAI_MODELS &gt; 預設路由</code>。</p>
  <pre>OPENAI_UPSTREAM=https://api.openai.com \\
OPENAI_API_KEY=your-openai-key \\
OPENAI_MODELS=gpt-5.6-sol \\
CLOUDFLARE_ACCOUNT_ID=your-account-id \\
CLOUDFLARE_API_TOKEN=your-cloudflare-token \\
CLOUDFLARE_MODELS=moonshotai/kimi-k3 \\
npx pxpipe-proxy</pre>
  <p>非 Anthropic 的模型 ID 會加上 <code>claude-</code> 前綴對外公告，因為 Claude Code 只認 Claude 形式的 ID；pxpipe 轉發前會把前綴拿掉。在 Claude Code 內用 <code>/model claude-&lt;model&gt;</code> 切換 — 例如 <code>/model claude-moonshotai/kimi-k3</code> — 或啟動時帶 <code>claude --model claude-moonshotai/kimi-k3</code>。可用 <code>curl …/v1/models</code> 確認有沒有被列出。</p>
  <p>上面的 <code>PXPIPE_MODELS</code> 是另一回事：它控制圖片壓縮，不是路由。Cloudflare 上的 Kimi K3 是唯一完整測過的非 Anthropic 模型 — 詳見 <code>docs/CLAUDE_CODE_PROVIDER_ROUTING.md</code>。</p>
  <button class="mini-btn" type="button" onclick="this.closest('dialog').close()">關閉</button>
</dialog>

<div id="frag-session" hx-get="/fragments/session-summary" hx-trigger="load, every 2s" hx-swap="innerHTML">
  <div class="hero hero-empty"><div class="hero-headline">連線中…</div></div>
</div>

<div id="frag-header" hx-get="/fragments/header" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>

<section class="section">
  <h2 class="section-head">你的 context 發生了什麼事 <span class="section-sub">點選單筆請求，看圖片與純文字的組成</span></h2>
  <div class="xray">
    <div class="xray-fit">
      <div class="card">
        <h3 class="card-head">最近的請求</h3>
        <div id="frag-recent" hx-get="/fragments/recent" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
      </div>
    </div>
    <div class="card">
      <h3 class="card-head">圖片與文字組成分析</h3>
      <div id="frag-context-map" hx-get="/fragments/context-map" hx-trigger="load" hx-swap="innerHTML"></div>
      <h3 class="card-head spaced">圖片 ↔ 原始文字對照</h3>
      <div id="frag-latest" hx-get="/fragments/latest" hx-trigger="load, every 2s, pp-refresh" hx-swap="innerHTML"
           hx-vals='js:{pin: window.pp.pin == null ? "" : window.pp.pin, source: window.pp.src ? "1" : ""}'></div>
    </div>
  </div>
</section>

<section class="section">
  <h2 class="section-head">Session 排行 <span class="section-sub">依節省的 token 數排序</span></h2>
  <div class="card">
    <div id="frag-sessions" hx-get="/fragments/sessions" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
  </div>
</section>

<section class="section">
  <h2 class="section-head">完整歷史 <span class="section-sub">磁碟上的所有事件</span></h2>
  <div class="card">
    <div id="frag-stats" hx-get="/fragments/stats" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
  </div>
</section>

<div class="tray" x-data="{ toasts: [], next: 1 }"
     @pp-toast.window="const id = next++; toasts.push({ id, text: $event.detail.text }); setTimeout(() => toasts = toasts.filter(t => t.id !== id), 5000)">
  <template x-for="t in toasts" :key="t.id">
    <div class="toast"><span x-text="t.text"></span><button type="button" @click="toasts = toasts.filter(x => x.id !== t.id)" aria-label="關閉">&times;</button></div>
  </template>
</div>

<script>${HTMX_JS}</script>
<script>${GLUE_JS}</script>
<script>${THEME_JS}</script>
<script>${ALPINE_JS}</script>
</body>
</html>`;
}
