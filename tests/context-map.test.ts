/**
 * The Context Map "Details" headline must use the SAME cache-weighted tokens
 * as the recent row's As-text / Sent / Saved columns. The old headline divided
 * the RAW count_tokens baseline by RAW sent tokens (cache-blind), so it could
 * trumpet "74% smaller" on a request the cache-aware row marked a net loss —
 * the exact contradiction that made the number untrustworthy. These tests pin
 * the two panels together.
 *
 * Warmth is server-observed: ContextMapData.warm is true only when the actual
 * request reported cache_read > 0. The narration must never claim a hypothetical
 * text cache read on a cache_read=0 row.
 */
import { describe, it, expect } from 'vitest';
import {
  renderContextMapFragment,
  renderRecentFragment,
  type ContextMapData,
} from '../src/dashboard/fragments.js';
import type { RecentPayload } from '../src/dashboard/types.js';

function ctx(p: Partial<ContextMapData> = {}): ContextMapData {
  return {
    id: 1,
    baselineTokens: 0,
    realInput: 0,
    baselineInputEff: 0,
    actualInputEff: 0,
    haveBaseline: true,
    cacheRead: 0,
    warm: false,
    output: 0,
    imageCount: 1,
    buckets: { static_slab: 1000 },
    imageIds: [1],
    compressed: true,
    ...p,
  };
}

describe('renderContextMapFragment — cache-aware headline', () => {
  it('says "smaller" only when the cache-weighted baseline actually beats what was sent', () => {
    const html = renderContextMapFragment(ctx({ baselineInputEff: 2000, actualInputEff: 400 }), []);
    expect(html).toContain('<span class="ctx-big">80%</span> 較小');
    expect(html).not.toContain('較大');
  });

  it('says "bigger" — not "smaller" — when imaging cost more than the cached text would have (the trust bug)', () => {
    // The user's real shape: cache-weighted text baseline (~1,500) < image sent
    // (~1,800). The RAW count_tokens (~7,500) is what made the old headline lie
    // "76% smaller" while the row's Saved column showed a loss. This is a WARM
    // turn (text prefix cached) that also read its image cache (cacheRead > 0) —
    // "would have been a cheap cache-read" is a true explanation for the gap.
    const html = renderContextMapFragment(
      ctx({
        warm: true,
        baselineInputEff: 1500,
        actualInputEff: 1800,
        baselineTokens: 7500,
        realInput: 1800,
        cacheRead: 1500,
      }),
      [],
    );
    expect(html).toContain('<span class="ctx-big">20%</span> 較大');
    // Must NOT resurrect the cache-blind "smaller" claim in the headline.
    expect(html).not.toContain('class="ctx-big">76%</span> 較小');
    // The sub-line still surfaces the raw shrink AND explains why it cost more.
    expect(html).toContain('雖小 76%');
    expect(html).toContain('快取讀取');
  });

  it('headline direction always agrees with the row Saved column (baselineInputEff − actualInputEff)', () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [2000, 400], // saving → smaller
      [1500, 1800], // loss → bigger
    ];
    for (const [b, a] of cases) {
      const html = renderContextMapFragment(ctx({ baselineInputEff: b, actualInputEff: a }), []);
      if (b - a > 0) {
        expect(html).toMatch(/ctx-big">\d+%<\/span> 較小/);
      } else {
        expect(html).toContain('較大');
      }
    }
  });

  it('makes no savings claim when the baseline probe did not resolve', () => {
    const html = renderContextMapFragment(
      ctx({ haveBaseline: false, baselineInputEff: 0, actualInputEff: 1800, baselineTokens: 7500, realInput: 1800 }),
      [],
    );
    expect(html).toContain('個計費等價輸入 token');
    expect(html).not.toContain('</span> 較小');
    expect(html).not.toContain('</span> 較大');
    expect(html).toContain('尚無可信的純文字基準');
  });
});

describe('renderContextMapFragment — cold vs warm honesty', () => {
  // The headline/sub-line must not claim a 0.1× read discount on a turn whose
  // actual request had no cache read. On a cold turn the text baseline's prefix
  // is priced at the 1.25× create rate too, so "cached text" / "reads at 0.1×"
  // would be counting unobserved cache as savings.
  it('COLD turn (no warmth): no read discount claimed, text is not called "cached"', () => {
    const html = renderContextMapFragment(
      ctx({
        warm: false,
        baselineInputEff: 1_600_000,
        actualInputEff: 12_600,
        baselineTokens: 1_280_000,
        realInput: 12_600,
        cacheRead: 0,
      }),
      [],
    );
    // headline: a real saving is still shown…
    expect(html).toContain('較小');
    // …but the text side is plain "text", never "cached text".
    expect(html).toContain('純文字會計費');
    expect(html).not.toContain('快取文字');
    // sub-line tells the truth about the cold turn instead of inventing 0.1×.
    expect(html).toContain('本回合沒有溫熱的文字快取');
    expect(html).not.toContain('（讀取以 0.1× 計），基準與「節省」欄相同');
  });

  it('WARM turn (text cached, image also hit): the 0.1× read basis is legitimately claimed', () => {
    const html = renderContextMapFragment(
      ctx({
        warm: true,
        baselineInputEff: 2000,
        actualInputEff: 400,
        baselineTokens: 9000,
        realInput: 600,
        cacheRead: 5000,
      }),
      [],
    );
    expect(html).toContain('較小');
    expect(html).toContain('快取文字會計費');
    expect(html).toContain('套用快取折扣後（讀取以 0.1× 計），基準與「節省」欄相同');
    expect(html).not.toContain('本回合沒有溫熱的文字快取');
  });

  it('COLD + bigger: still no fabricated read discount', () => {
    // Imaging cost more even cold (image tokens > text tokens). The sub-line must
    // attribute it to token count, not a phantom cache-read.
    const html = renderContextMapFragment(
      ctx({
        warm: false,
        baselineInputEff: 1000,
        actualInputEff: 1500,
        baselineTokens: 1100,
        realInput: 1500,
        cacheRead: 0,
      }),
      [],
    );
    expect(html).toContain('較大');
    expect(html).toContain('純文字則為');
    expect(html).not.toContain('快取文字');
    expect(html).toContain('本回合沒有溫熱的文字快取');
    expect(html).not.toContain('便宜地走快取讀取');
  });

  it('cache_read=0: text is cold too, no cache-busted warm-text narration', () => {
    const html = renderContextMapFragment(
      ctx({
        warm: false,
        cacheRead: 0,
        baselineInputEff: 3500,
        actualInputEff: 2500,
        baselineTokens: 3000,
        realInput: 2000,
      }),
      [],
    );
    expect(html).toContain('較小');
    expect(html).toContain('純文字會計費');
    expect(html).toContain('本回合沒有溫熱的文字快取');
    expect(html).not.toContain('快取文字');
    expect(html).not.toContain('re-imaged the prefix and missed the image cache');
  });
});

describe('renderRecentFragment — billed delta presentation', () => {
  it('shows negative saved deltas instead of hiding imaging losses as missing data', () => {
    const html = renderRecentFragment({
      recent: [
        {
          ts: 0,
          method: 'POST',
          path: '/v1/messages',
          status: 200,
          compressed: true,
          cc_added: 1,
          cache_read: 0,
          baseline_input: 7618,
          actual_input: 69526,
          session_saved_so_far_delta: -61908,
        },
      ],
      has_preview: false,
      preview_meta: '',
    } satisfies RecentPayload);

    expect(html).toContain('省下／多花');
    expect(html).toContain('class="num neg">-61,908</td>');
    expect(html).not.toContain('class="num pos">—</td>');
  });
});

describe('renderContextMapFragment — the 100-image request cap', () => {
  // The cap is the single most confusing thing about a turn that compressed
  // badly: the user sees "only 3 pages imaged" and no reason why. These lines
  // name the reason, and only when there is one.
  it('says so when the client\'s own images ate into the cap', () => {
    const html = renderContextMapFragment(ctx({ nativeImages: 12 }), []);
    expect(html).toContain('有 12 張圖片來自你這端');
    expect(html).toContain('單次請求 100 張圖片的上限');
  });

  it('reports pages that were rendered but never sent', () => {
    // 40 ours + 2 theirs = 42 rendered, 28 on the wire → 14 absorbed.
    const html = renderContextMapFragment(ctx({ imageCount: 40, nativeImages: 2, wireImages: 28 }), []);
    expect(html).toContain('有 14 頁已算繪的圖片未送出');
    expect(html).toContain('實際上線 28 張');
  });

  it('reports blocks that stayed text because the cap was full', () => {
    const html = renderContextMapFragment(ctx({ imageBudgetSkips: 3 }), []);
    expect(html).toContain('有 3 個區塊因圖片額度已滿而維持純文字');
  });

  it('uses the singular where it should', () => {
    const html = renderContextMapFragment(ctx({ nativeImages: 1, imageBudgetSkips: 1 }), []);
    expect(html).toContain('有 1 張圖片來自你這端');
    expect(html).toContain('有 1 個區塊因圖片額度已滿而維持純文字');
  });

  it('stays silent on an ordinary turn', () => {
    const html = renderContextMapFragment(ctx({ imageCount: 3, wireImages: 3 }), []);
    expect(html).not.toContain('cap-note');
  });

  it('stays silent when the wire count merely agrees', () => {
    const html = renderContextMapFragment(ctx({ imageCount: 3, nativeImages: 0, wireImages: 3 }), []);
    expect(html).not.toContain('未送出');
  });
});

