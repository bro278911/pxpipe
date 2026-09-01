# pxpipe

**將龐大的 Context 渲染成圖片，大幅削減 Claude Code 的輸入 Token 用量 — 相同的 system prompt、工具文件與歷史記錄，只需原來幾分之一的 Token 即可傳遞。**

圖片的 Token 費用取決於像素尺寸，而非圖內文字量。在實際 Claude Code 流量中，密集內容（程式碼、JSON、工具輸出）每個圖片 Token 可容納約 3.1 個字元，而文字 Token 每個僅容納約 1 個字元。這個讀取管道正是 Anthropic computer use 用來處理截圖的同一視覺通道。pxpipe 是一個本機 proxy，透過該通道傳遞 Context：它在請求離開機器之前，將每個請求的龐大部分改寫為緊湊的 PNG。以目前 Fable 定價計算，可降低約 **~59–70% 的端對端費用** — 但價格會變動、工作負載也各有不同，因此更穩健的指標是 Token 削減量本身，可逐請求對照 `~/.pxpipe/events.jsonl` 中免費的 `count_tokens` 反事實基準進行量測。

以下是模型看到的內容（取代文字）：

![example: a real `transformRequest` output: system prompt + tool docs reflowed into one dense page, instruction banner on top, ↵ marking original newlines](https://raw.githubusercontent.com/teamchong/pxpipe/main/docs/assets/example-render.png)

*約 48k 字元的 system prompt 與工具文件：以文字形式約需 ≈25k Token，以此頁圖片形式約需 ≈2.7k 圖片 Token。實際管道輸出；模型以 100/100 的成績讀取此類渲染（見評測結果）。*

![chart: characters a frontier context window holds, 2018–2026 — vendor text series including Grok 4.5; orange measured overlays are Fable 5 [1m] + pxpipe ~19.0M (4.8×) and Gemini 3.6 Flash + pxpipe ~21.3M (5.3×)](docs/assets/context-window-chars.png)

*八年來 Context 視窗的字元數成長歷程。所有文字折線頂部接近 ~4M 字元（1M Token 視窗，以 ~4 字元/Token 計算）；**Grok 4.5** 僅以文字視窗標記點呈現（500K）。橙色疊加層代表以 pxpipe 圖片讀取的**同一組 1M 視窗** — Fable 5 達 ~19.0M 字元（**4.8×**），Gemini 3.6 Flash 達 ~21.3M 字元（**5.3×** 文字容量）。密度值由生成時的實際渲染量測，非手動輸入：以 `npx tsx scripts/gen-context-chart.ts` 重新生成（[原始碼](scripts/gen-context-chart.ts)）。*

## Demo

**Fable 5（預設，100/100 讀取率）— 左側為純文字，右側為 pxpipe：**

https://github.com/user-attachments/assets/1c8ee63a-fcd7-4958-917b-da788d718349

pxpipe 在 39 個圖片填充檔案中精確計算 Token **10/10**（逐行與 `grep` 吻合），正確完成多步驟帳本運算，並在 context 尚有餘裕時（73.5k/1M）以 **$6.06** 結束會話，相比之下純文字版在 96% 額滿時花費 **$42.21**。影片中有一個注意事項：pxpipe 那側需要補充提示才能符合所要求的單行輸出格式。

## Try it (30 seconds)

```bash
npx pxpipe-proxy                                  # proxy 在 127.0.0.1:47821
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude  # 將 Claude Code 指向 proxy
```

儀表板位於 <http://127.0.0.1:47821/>：已節省的 Token、每次文字→圖片轉換的對照、Kill Switch 及即時模型選項。回應正常串流 — pxpipe 只壓縮*請求*，從不壓縮模型的輸出。最近的對話輪次保留為文字；system prompt、工具文件與較舊的大量歷史記錄則會被轉為圖片。

### Windows (PowerShell)

Windows 目前由社群支援。請開啟兩個 PowerShell 視窗：第一個持續執行
pxpipe，第二個再啟動你的 Agent。需要 Node.js 20.19 或更新版本。

```powershell
# PowerShell 視窗 1：啟動本機 proxy。
npx pxpipe-proxy
```

使用 Claude Code 時，僅在目前 PowerShell 工作階段設定 Anthropic base URL，
再正常啟動 Claude：

```powershell
# PowerShell 視窗 2
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:47821'
claude

# 選用：Claude 結束後移除設定。
$env:ANTHROPIC_BASE_URL = $null
```

使用 Codex 或其他相容 OpenAI 的用戶端時，改將其 OpenAI base URL 指向
pxpipe 的 `/v1` endpoint：

```powershell
# PowerShell 視窗 2
$env:OPENAI_BASE_URL = 'http://127.0.0.1:47821/v1'
codex

# 選用：Codex 結束後移除設定。
$env:OPENAI_BASE_URL = $null
```

預設建議不要永久保存任一 URL：本機 proxy 未執行時，Agent 將無法連線到其
提供者。pxpipe 會轉送 Agent 現有的提供者憑證；只有在刻意覆寫用戶端金鑰時，
才需要在 pxpipe 行程設定 `OPENAI_API_KEY`。

#### 停用、永久設定與還原

只想在目前 PowerShell 工作階段停止使用 pxpipe 時，先在執行 proxy 的視窗按下
`Ctrl+C`，再在 Agent 視窗移除設定並重新啟動 Agent：

```powershell
# 在目前 PowerShell 工作階段還原 Claude Code 與 Codex 的預設連線。
$env:ANTHROPIC_BASE_URL = $null
$env:OPENAI_BASE_URL = $null

# 確認目前工作階段不再設定 pxpipe URL。
Get-ChildItem Env:ANTHROPIC_BASE_URL, Env:OPENAI_BASE_URL -ErrorAction SilentlyContinue
```

只有在你會固定讓 pxpipe 持續執行時，才使用永久設定。下列命令將 URL 寫入
目前 Windows 使用者的環境變數；設定後必須關閉並重新開啟 PowerShell。

```powershell
# 永久設定 Claude Code 使用 pxpipe。
setx ANTHROPIC_BASE_URL "http://127.0.0.1:47821"

# 永久設定 Codex 使用 pxpipe。
setx OPENAI_BASE_URL "http://127.0.0.1:47821/v1"
```

要還原成直接連線到原始提供者，刪除對應變數後重新開啟 PowerShell：

```powershell
# 還原 Claude Code 的預設連線。
Remove-ItemProperty -Path 'HKCU:\Environment' -Name 'ANTHROPIC_BASE_URL' -ErrorAction SilentlyContinue

# 還原 Codex 的預設連線。
Remove-ItemProperty -Path 'HKCU:\Environment' -Name 'OPENAI_BASE_URL' -ErrorAction SilentlyContinue
```

若是在同一個已開啟的 PowerShell 立即還原，請一併執行上方的
`$env:... = $null` 兩行；否則該視窗仍會保留舊值，直到關閉為止。

設定 `ANTHROPIC_BASE_URL` 會讓 Claude Code 認定自己並未連線到第一方 API，
因而停用 `/remote-control` 與 claude.ai 連接器。若需保留這些功能，請改用
下列兩種轉送 proxy 方式之一。

### 轉送 proxy（保留第一方功能）

pxpipe 的主 port 同時也是一個 CONNECT 轉送 proxy，因此 Agent 可以透過
`HTTPS_PROXY` 而非 base URL 連線 —— 它眼中連線目標仍是 `api.anthropic.com`，
第一方檢查照常通過，而 `/v1/messages` 會在本機被導向 pxpipe 記帳。轉送
proxy 僅接受 loopback 來源的連線。

Claude Code 只需在 `~/.claude/settings.json` 設定一次，之後每個視窗自動生效：

```json
{
  "env": {
    "HTTPS_PROXY": "http://127.0.0.1:47821",
    "NODE_EXTRA_CA_CERTS": "C:\\Users\\<you>\\.pxpipe\\warp-ca.pem"
  }
}
```

CA 憑證路徑會在 proxy 啟動時印出。該 CA 只用於簽發本機攔截用的憑證，
不會安裝到系統憑證存放區。

proxy 未執行時 Agent 會連不上提供者，因此此設定適合固定讓 pxpipe 常駐的情況。

### `pxpipe warp`

```bash
pxpipe warp -- claude          # 也可以：cursor-agent、codex 或 shell alias
```

與 `ANTHROPIC_BASE_URL` 方式效果相同，但保留了 `/remote-control`、claude.ai 連接器及第一方閘道的正常運作。完整說明請見儀表板。

`api.anthropic.com/v1/messages` 為預設路由。透過其他 base URL 連接提供者的 Agent 需另行設定規則，指定 port 的規則只匹配該 port：

```bash
pxpipe warp --route '127.0.0.1:9090/v1/*=http://127.0.0.1:47821' -- codex
```

## Offline export (no proxy)

無需執行 proxy（without running the proxy）或連接 Claude Code，即可將文字、檔案或 diff 渲染為 PNG 頁面：

```bash
npx pxpipe-proxy export src/
cat prompt.txt | npx pxpipe-proxy export --stdin
npx pxpipe-proxy export --git
```

若已安裝套件，請以 `pxpipe export` 取代 `npx pxpipe-proxy export`。

每次執行都會產生一個新的 `pxpipe-export-XXXXXX/` 輸出資料夾（命令完成時會印出確切路徑），其中包含 `page-*.png`、`factsheet.txt`、`manifest.json` 和 `prompt.txt`。在不執行 proxy 的情況下需要密集視覺 Context 時，可將 PNG 頁面上傳並把 prompt 貼入支援圖片上傳的用戶端（例如 Cursor）。

## The honest part

- **有損壓縮。** 密集圖片內容中的精確 12 字元十六進位字串：Fable 5 有 **13/15**、Sol 有 **0/15** — 錯誤為*靜默幻覺*，而非顯性錯誤。位元組精確的值（ID、雜湊、密鑰）必須保留為文字；最近輪次已做到這一點。Factsheet 選擇性保留最多 96 個已識別的精度關鍵 Token，而非所有識別碼。專用的逐字風險防護機制尚未建置。
- **逃生出口：** 不在允許清單的模型上執行的子代理將以文字形式傳送 — 需要位元組精確結果的工作請路由至這些子代理（`CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-6`，或在 agent frontmatter 中設定 `model: sonnet`）。
- **真實工作成效：** SWE-bench Lite 試驗**兩臂各 10/10**，請求體積縮小 65%；SWE-bench Pro **pxpipe 14/19 vs 純文字 15/19**，縮小 60%，18/19 結論一致，唯一分歧案例在重複執行時 3/3 再現 — 屬執行間差異，非壓縮導致。樣本數較小；原始數據在 `eval/`。
- **取決於工作負載。** Token 密集內容（~1 字元/Token）有利可圖；稀疏散文（~3.5 字元/Token）則可能虧損；收益閘門（以 N=391 筆生產資料校準）只在數學上合算時才進行圖片化。
- **取決於用戶端。** 節省量對應用戶端仍以文字重新傳送的未快取大量內容。Claude Code 在 `/anthropic/messages` 上重新傳送 system + tools + history，通常可達 ~60–70% 節省。詳細說明與量測分拆：[docs/CACHING_AND_SAVINGS.md](docs/CACHING_AND_SAVINGS.md)。

<details>
<summary><strong>模型支援與渲染細節</strong></summary>

- **`claude-opus-5`：** 逐字召回率弱於 Fable 5（逐字 **2/15 vs 13/15**），其他方面表現尚可（運算 100/100，never-stated 0/16），`/compact` 前達 **~4.7×** Context。建議 effort：**medium**。詳細說明：[FINDINGS.md](FINDINGS.md)。
- **模型範圍：** 預設 `PXPIPE_MODELS=claude-fable-5,gemini-3.6-flash,gemini-3.7-flash`。Opus 5、Sol、GPT 5.5 及 **Grok** 均為選擇加入（儀表板選項或 `PXPIPE_MODELS`）。Sol 的精確模型 ID 仍然重要。同系列變體（如 `gpt-5.6-terra`）不繼承 Sol 的允許清單或渲染設定檔。`PXPIPE_MODELS=off` 可停用圖片化。其餘所有內容均以位元組一致方式傳送。在 GPT 路徑上，工具定義保持原生 JSON 格式，不使用 Anthropic `cache_control` 標記。Responses 歷史記錄壓縮可識別已完成的 `function_call`/`function_call_output` 配對，包括 OpenCode 的並行呼叫-輸出回合：只有舊的已關閉回合會以原子方式圖片化；每個開放呼叫及格式錯誤/孤兒狀態均保留為原生格式。基本設定檔保留最新六對已完成配對，允許 32 張圖片；Sol 保留一對，允許 64 張圖片；Grok 允許 24 張圖片。在驗證提供者的請求上限後，可以透過 `PXPIPE_GPT_HISTORY_MAX_IMAGES=48` 調整選擇加入的長會話覆蓋範圍（防禦性上限為 100）。
- **逐模型渲染：** 選擇加入的 `gpt-5.6-sol` 和 Grok 使用 9×16 儲存格中的原生 14px JetBrains Mono 字形、84 欄及 764px 全寬條帶；Claude 保留其 312 欄、1568×728 的 5×8 Spleen 設定檔。這些設定根據精確的模型 ID 選擇，包括歷史記錄頁面和收益計算。已識別的 ID 可附在有界 Factsheet 中，且最近/開放的工具狀態保留為原生格式。
  [Sol 數據](eval/sol-profile/QUALITY_RESULTS.md) 和
  [設定檔證據](docs/MODEL_RENDER_PROFILES.md)。
- **Grok 4.5（選擇加入）：** 原生 14px / 84 欄 / maxH 512（運算 100/100，gist 97/98）。預設關閉（密集十六進位仍為 0/15）。
  以 `PXPIPE_MODELS=claude-fable-5,grok-4.5` 或儀表板選項啟用。
  [eval/grok-density/QUALITY_RESULTS.md](eval/grok-density/QUALITY_RESULTS.md)。

</details>

## Benchmark results and receipts

### Model quality

此矩陣同時呈現覆蓋範圍與分數。`—` 表示該模型未在該測試中執行，不代表零分。運算測試使用全新隨機數問題。Gist、state 與 never-stated 探針共用同一語料庫。Never-stated 為幻覺，越低越好。

| 模型 | 運算 (N=100) | gist (N=98) | state (N=18) | never-stated (N=16) | 密集十六進位 (N=15) | 設定檔來源與數據 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `claude-fable-5` | **100/100** | **98/98** | **18/18** | **0/16** | 13/15 | 2026 年 6 月生產設定檔：[運算 + 十六進位](FINDINGS.md)，[gist/state/guards](eval/gist-recall/) |
| `google/gemini-3.6-flash`, `3.7-flash` | **100/100** | **98/98** | **18/18** | **0/16** | **14/15** | 目前已發佈設定檔：[品質結果](eval/gemini-profile/QUALITY_RESULTS.md) |
| `claude-opus-5` | **100/100** | 94/98 | 17/18 | **0/16** | 2/15 | 目前設定檔：[運算](eval/gsm8k/)，[gist/state/guards](eval/gist-recall/)，[密集十六進位](eval/verbatim-15/) |
| `gpt-5.6-sol` | 98/100 | 83/98 | 17/18 | 4/16 | 0/15 | 前期 5×8 完整套件；原生 14px 試驗：精確 7/8，0 幻覺，gist/guard 通過：[試驗](eval/sol-profile/README.md) |
| `claude-opus-4-8` | 93/100 | 77/98 | **18/18** | **0/16** | 0/15 | 歷史設定檔：[運算](eval/gsm8k/)，[gist/state/guards](eval/gist-recall/)，[密集十六進位](eval/needle-haystack/) |
| `grok-4.5` | **100/100** | **97/98** | 17/18 | **0/16** | 0/15 | 原生 14px/84 品質套件（即時設定檔）；[品質](eval/grok-density/QUALITY_RESULTS.md)，[native-sweep](eval/grok-density/native-sweep/RESULTS.md) |
| `grok-4.6` high | **100/100** | **97/98** | 17/18 | **0/16** | 0/15 | 原生 14px/84，reasoning high；[品質](eval/grok-profile/QUALITY_RESULTS.md) |
| `moonshotai/kimi-k3` | 79/100 | 84/98 | 15/18 | 1/16 | 0/15 | 通用 GPT 設定檔：[品質結果](eval/sol-profile/KIMI_K3_QUALITY_RESULTS.md) |
| `qwen-3.8` (`@cf/qwen/qwen3.8-27b`) | 98/100 | 72/98 | 11/18 | **0/16** | 0/15 | 前期 5×8 完整套件（十六進位 0/15）；原生 14px 試驗：精確 8/8，0 幻覺，十六進位 11/15：[試驗與品質](eval/qwen-profile/QUALITY_RESULTS.md) |

### Native-profile cost check

以每個完整設定檔對同一 454,045 字元密集記錄語料庫進行離線匯出，結果如下：

| 模型設定檔 | 頁數 | 文字估算 | 圖片 Token | 節省率 |
|---|---:|---:|---:|---:|
| Claude, Spleen 5×8 | 17 | 122,715 | 23,856 | 80.6% |
| Sol, JetBrains Mono 14px | 45 | 122,715 | 65,424 | 46.7% |

文字估算使用 3.7 字元/Token；圖片 Token 使用各模型的提供者公式與實際渲染頁面尺寸。這些數字確立了此語料庫上的設定檔成本，而非通用工作負載節省率。Sol 的付費固定測試估算為 42%，同時精確讀取 7/8，無不支援的幻覺。

各次執行使用不同的傳輸方式和設定檔版本，圖片幾何並不完全相同。Fable 和 Opus 使用 Claude；Gemini 使用 Google AI Studio；Sol 和 Grok 使用 Codex Responses；Kimi K3 使用 Cloudflare 的 OpenAI 相容傳輸。目前的生產設定檔包含相鄰的有界 Factsheet；歷史版本或純圖片例外情況在連結的評測中有說明。

### Model-specific evaluations

以下非跨模型比較。所有未列出的模型均**未執行**。

| 測試 | 模型 | 結果 | 評測與數據 |
| --- | --- | --- | --- |
| SWE-bench Lite | `claude-fable-5` | pxpipe 10/10; text 10/10; −65% request size | [配對試驗](eval/swe-bench/) |
| SWE-bench Pro | `claude-fable-5` | pxpipe 14/19; text 15/19; −60% request size | [配對試驗](eval/swe-bench-pro/) |
| 生產歷史列本地化 | `google/gemini-3.6-flash` | text 17/30; pxpipe 18/30 | [位置檢索](eval/gemini-profile/QUALITY_RESULTS.md#production-history-positional-retrieval) |
| 生產歷史精確列 | `google/gemini-3.6-flash` | text 3/30; pxpipe 3/30 | [位置檢索](eval/gemini-profile/QUALITY_RESULTS.md#production-history-positional-retrieval) |

SWE-bench 執行器為 Claude Code/Fable 專用；其他模型均無 ON/OFF 對照執行。Gemini 的位置檢索掃描是方向性證據，而非通用的「迷失在中間」結果。

### Capacity / density (how many chars per vision-token?)

透過實際管道渲染此 repo 的密集測試固定檔，並以各系列的視覺 Token 費率計算像素成本。倍數 = 量測到的字元/視覺 Token ÷ 4（散文文字基準）。非模型品質分數。

| 系列 | 視窗 | 文字形式 (@4 字元/Token) | pxpipe 圖片形式 | 密度 | 倍數 |
|---|---:|---:|---:|---:|---:|
| **`claude-fable-5[1m]`** (default) | 1M | ~4.0M | **~18.9M** | ~18.9 c/vt (exact 28px patches) | **~4.7×** |
| **`google/gemini-3.6-flash`** | 1M | ~4.0M | **~20.1M** | ~20.1 c/vt (1,078 tok/page) | **~5.0×** |
| **`claude-opus-5`** | 1M | ~4.0M | **~18.9M** | ~18.9 c/vt (resolves to Fable 5’s geometry) | **~4.7×** |

重新生成：`npx tsx scripts/gen-context-chart.ts` · 圖表 PNG [`docs/assets/context-window-chars.png`](docs/assets/context-window-chars.png)。

較舊的 GSM8K 結果已省略，因為訓練資料污染可能掩蓋圖片誤讀；連結的運算評測使用全新數字。

## How it works

```
model id ──► render profile ──► wrap/reflow bulk context ──► PNG[] + bounded factsheet
```

此 proxy 處理 Anthropic Messages、OpenAI Responses 及 Chat Completions，以及 Google `generateContent` 請求。它將符合條件的大量內容改寫為圖片區塊，並轉發給提供者原生請求，或將 Anthropic Messages 橋接到已設定的 OpenAI 相容提供者。在 Anthropic 端，靜態前綴和 prompt 快取邊界得以保留。模型專屬設定檔控制幾何形狀、Factsheet、歷史記錄保留及收益性，因此稀疏散文保持文字形式。事件記錄於 `~/.pxpipe/events.jsonl`。

## Library use (no proxy)

```ts
import { renderTextToImages, transformAnthropicMessages } from "pxpipe-proxy";

const { pages } = await renderTextToImages(toolResultText);     // pages[i].png: Uint8Array
const { body, applied, info } = await transformAnthropicMessages({
  body: requestBytes,
  model: "claude-fable-5",
});
```

`options.keepSharp(block)` 將區塊固定為文字；`options.emitRecoverable` 回傳圖片化區塊的原始內容。純 JS 執行環境（Node 及 edge/Workers）；`@napi-rs/canvas` 僅在建置時使用。完整 API：`src/core/index.ts`。

<details>
<summary><strong>離線統計（無 proxy）：<code>pxpipe stats</code></strong></summary>

即時儀表板在 proxy 執行期間顯示節省情況。若要在**事後** — 沒有伺服器的情況下 — 讀取相同的事件記錄，可直接從磁碟摘要：

```bash
pxpipe stats                   # 人類可讀報告，來源：~/.pxpipe/events.jsonl
pxpipe stats --json            # 相同彙總資料，以機器可讀 JSON 格式輸出
pxpipe stats --file /path/to/events.jsonl
```

除了請求次數、壓縮比、延遲百分位數和快取命中率之外，報告還會印出**量測節省**標題行 — 僅在探針量測的資料行上，對比原始內容的 `count_tokens` 與實際用量（未量測的請求被排除，不計為零）。這是**原始 Token** 數字（快取讀取以面值計算，非以成本加權），因此刻意與儀表板的成本加權節省 % 不同。使用 `--file` 指向非預設記錄，或設定 `PXPIPE_LOG`。

結束代碼：`0` 報告已印出，`1` 找不到事件檔案，`2` 檔案存在但無有效事件。`pxpipe stats --help` 印出使用說明。

</details>

## Development

```bash
pnpm install && pnpm test
pnpm run build                # 重新生成 dist/
```

本地開發時，可使用下列指令啟動服務：

```bash
pnpm run dev:node             # 啟動 Node.js proxy，並監看原始碼變更
pnpm run dev:worker           # 啟動 Cloudflare Worker 本地開發伺服器
```

Windows 由社群支援：主要開發目標為 macOS/Linux，Windows 專屬修復依賴貢獻者的 PR（感謝 @makoribrian）。

## FAQ

<details>
<summary><strong>標題數字是端對端的，還是只針對所接觸的請求？</strong></summary>

端對端，整張費用單。大多數壓縮工具只回報其所接觸的輸入切片的節省量，這會使數字看起來更好看。端對端的分母是*所有*生產請求：pxpipe 正確地保持未處理的小型請求、所有快取寫入與讀取，以及所有輸出 Token（proxy 從不壓縮這些）。在 13,709 個請求的快照中，節省為 59%（$100 → ~$41）；後來 8,904 個壓縮請求的追蹤量測到 ~70%。僅計算壓縮請求時更高（~72–74%），此數字另行引用，從不作為標題數字。確切數字取決於工作負載 — 請在自己的記錄上重現。

</details>

<details>
<summary><strong>數字如何量測？</strong></summary>

同一請求的兩側，在同一時刻。對於每個 `/v1/messages` POST，proxy 在與實際轉發並行的同時，對原始未壓縮內容（反事實）觸發免費的 `count_tokens` 探針，並從回應中讀取 Anthropic 實際計費的 usage 區塊。兩者均落在 `~/.pxpipe/events.jsonl` 的同一行，因此不存在輪次計數或執行間的混淆變數。美元換算使用 Fable 5 定價比例：輸入 ×1.0，快取寫入 ×1.25，快取讀取 ×0.1，輸出 ×5。快取定價對兩側一致套用，因此快取折扣相互抵消，不會被重複計算為「節省」。請從事件記錄自行推導：公式和欄位名稱記錄於 `src/core/baseline.ts`。

</details>

<details>
<summary><strong>它實際上壓縮什麼？</strong></summary>

三種*輸入*區塊，各自有收益閘門把關：

1. 大型 `tool_result` 內容（檔案讀取、命令輸出、記錄），超過約 6k 字元的 Token 密集內容
2. 較舊的折疊歷史：活動尾端之後的輪次被重新渲染為圖片頁面，最近輪次始終保留文字
3. 靜態可快取的 system prompt + 工具文件板塊；附加的不可快取 system 區塊保留為即時文字，以維持宿主自訂指示的系統層顯著性

其他所有內容均以位元組一致方式傳送：您的訊息、最近輪次、模型輸出（即回應，proxy 從不觸碰）、稀疏散文，以及任何過小而無法獲益的內容。模型預設值和詳細結果列於[模型支援](#the-honest-part)和[評測結果](#benchmark-results-and-receipts)。

</details>

<details>
<summary><strong>在評測之外，它是否曾在真實情況下失效？</strong></summary>

是的，在數週的日常使用中發生過一次：模型從圖片化的聊天歷史中召回了一個人的姓名，且自信地給出了錯誤的名字。沒有錯誤提示，只是一個看似合理的錯誤名字。這就是已記錄的失效模式：圖片內容中的精確字串不能保證位元組安全。程式碼作業能容忍這個問題，因為代理在編輯前會重新讀取檔案；純聊天召回則沒有此類檢查。此失效模式已有量測，非僅憑軼事：
[可讀性稽核](docs/LEGIBILITY-AUDIT-2026-07-01.md)量化了渲染頁面的精確字串召回率（對密集識別碼的盲讀成功率最高為 63%，每次錯誤均可由字形易混淆矩陣預測），並記錄了已發佈的緩解措施 — 頁面幾何形狀夾緊至 API 的重採樣上限，以使計費像素確實到達視覺編碼器，以及選定的識別碼（SHA、數字）作為文字隨附傳送。

</details>

<details>
<summary><strong>為何錯誤是靜默幻覺而非讀取錯誤？</strong></summary>

因為模型視覺並非 OCR：圖片變成 patch 嵌入，而非離散字元，因此沒有逐字形的信心值可以失敗。當像素不足以確定字形時，語言先驗會以看似合理的內容填補缺口。機制與數據：
[docs/NOT-OCR.md](docs/NOT-OCR.md)。

</details>

<details>
<summary><strong>DeepSeek-OCR 不是已經證明這在實踐中不成立嗎？</strong></summary>

不：它證明了這個通道有效，使用了專門為此訓練的編碼器/解碼器配對。這種懷疑論源自 2025 年 10 月，當時沒有任何現成的生產模型能夠讀取密集渲染；隨著 Fable 5 的出現而改變（先前 Opus 世代逐字十六進位 0/15，Fable 5 則達 13/15，相同頁面）。時間線和逐模型數字：[docs/NOT-OCR.md](docs/NOT-OCR.md)。

</details>

<details>
<summary><strong>為何這份 README 讀起來像 AI 寫的？</strong></summary>

因為確實是 AI 寫的。這個 repo 的大多數提交 — 程式碼和文件 — 都是由在 pxpipe 本身後端執行的 Opus/Fable 代理作業所撰寫的，這些代理在工作時將自己的折疊歷史讀取為圖片頁面。

</details>

## Additional limitations

- PNG 編碼在大型請求離開前增加延遲。
- ASCII/Latin-1 測試完善；CJK 可用，但較為保守。

## Research status

截至 2026-07-22。2026-07-05 版本的廣泛結論仍然成立：精確召回受每個字形像素數的限制，因此渲染變更無法在有利密度下消除錯誤。後來的字形風格 A/B 測試確實發現了一項有用的局部改進：重繪 `K` 將 Fable 的 H/K 錯誤從 47.2% 降至 18.7%，且不改變幾何形狀或 Token 成本。此改進已發佈，但精確控制 ID 並未改善。參見 [FINDINGS.md](FINDINGS.md)，2026-07-19 條目。

執行期金絲雀 + 文字重新擷取，以及代理讀取器預飛行檢查仍未測試。版本觸發條件仍是每個新模型的解析度掃描；能夠以接近 100% 的成功率讀取生產儲存格的模型將允許更高的密度。

有效 Context 的效益仍未得到證實。上述生產歷史結果是方向性證據，而非一般性的 Context 視窗或長任務準確率聲明。

## Community projects

此處列出的第三方專案並非由 pxpipe 維護或支援。

- [pxpipe-windows](https://github.com/DivyeshPatro/pxpipe-windows) — `pxpipe mitm` 的 Windows 支援（使用 node-forge CA 取代 openssl，Task Scheduler 自動啟動）。
- [OmniGlyph](https://github.com/diegosouzapw/OmniGlyph) — 由社群維護、衍生自 pxpipe 的專案，供 [OmniRoute](https://github.com/diegosouzapw/OmniRoute) 使用。
- [pxpipe-go](https://github.com/evan-choi/pxpipe-go) — pxpipe 核心的 Go 移植版，具有 CLI 包裝器、獨立 proxy 及支援 Anthropic Messages 和 OpenAI Chat/Responses 的可嵌入函式庫。

## License

MIT.
