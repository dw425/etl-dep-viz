# V11 Complexity Analysis Report

**Upload:** PRD1_WF_XML (Upload #9)
**Total Sessions:** 13,084
**Analysis Date:** 2026-03-01
**Engine:** V11 Complexity Analyzer (Percentile-Based Normalization)

---

## 1. Algorithm Overview

The V11 Complexity Analyzer scores each ETL session across **8 orthogonal dimensions** of complexity, producing a weighted composite score from 0-100 that maps to a migration difficulty bucket.

### Scoring Pipeline

```
XML Parse → Feature Extraction → 8 Raw Dimensions
                                       ↓
                              Percentile Normalization (0-100 per dimension)
                                       ↓
                              Weighted Sum (dimension weight × normalized score)
                                       ↓
                              Overall Score (0-100) → Bucket Assignment → Hours Estimate
```

### Why Percentile Normalization

The previous min-max normalization (`(raw - min) / (max - min)`) was destroyed by outliers. With a max of 179 transforms, a session with 10 transforms scored only 5.6% — crushing 98.4% of sessions into "Simple."

**Percentile normalization** ranks each session within the population. A session at the 50th percentile scores 50, regardless of whether the max is 179 or 17,900. This is outlier-resistant and produces meaningful differentiation.

**Zero-aware mode** (for D1, D3, D4, D5, D6, D8): Raw value 0 always maps to normalized 0. Non-zero values are percentile-ranked within the non-zero subset (scaled 1-100). This prevents sessions with zero risk from getting a non-zero risk score just because of their population rank.

---

## 2. Dimension Definitions

| Dim | Name | What It Measures | Weight | Raw Source |
|-----|------|------------------|--------|------------|
| **D1** | Transform Volume | Processing complexity — how many transformation operations | **15%** | `session.transforms` |
| **D2** | Table Diversity | Breadth of data touch — count of unique tables (source ∪ target ∪ lookup) | **10%** | `len(unique_tables)` |
| **D3** | Risk | Data quality risk — write conflicts + staleness risks | **20%** | `write_conflict_count + staleness_risk` |
| **D4** | IO Volume | Total data connections — source + target + lookup table references (non-unique) | **10%** | `len(sources) + len(targets) + len(lookups)` |
| **D5** | Lookup Intensity | Lookup complexity — number of lookup/reference table operations | **10%** | `session.lookupCount` |
| **D6** | Coupling | Cross-session entanglement — how many other sessions share tables | **15%** | Shared-table session overlap count |
| **D7** | Structural Depth | Position in dependency chain — tier level (higher = deeper dependencies) | **10%** | `session.tier` |
| **D8** | External Reads | External I/O complexity — number of external read operations | **10%** | `session.extReads` |

**Total Weight: 100%**

### Dimension Details

**D1 — Transform Volume (15%)**
Counts the number of transformation operations within a session. More transforms = more logic to migrate, test, and validate. A session with 1 transform is a simple pass-through; a session with 50+ is a multi-stage data pipeline.

**D2 — Table Diversity (10%)**
Counts the unique tables across all sources, targets, and lookups. Higher diversity means the session integrates data from many different entities, increasing migration scope and testing surface.

**D3 — Risk (20%)** — *Highest weighted dimension*
Combines write conflict count (multiple sessions writing to the same table) and staleness risk (reading from tables with stale data). This dimension has the highest weight because write conflicts are the #1 source of migration bugs and data corruption.

**D4 — IO Volume (10%)**
Total count of all table references (including duplicates). Unlike D2 which counts unique tables, D4 measures how many individual read/write/lookup operations exist. A session reading from Table_A three times has D2=1 but D4=3.

**D5 — Lookup Intensity (10%)**
Counts lookup/reference table operations. Lookups require special handling during migration (caching, join optimization, lookup table availability) and are a common source of performance issues.

**D6 — Coupling (15%)**
Counts how many other sessions share at least one table with this session. A session coupled to 2,000+ other sessions means any change ripples across the estate. Computed by building a `table → sessions` index and counting unique overlapping sessions per session.

**D7 — Structural Depth (10%)**
The session's tier level — position in the dependency chain. Tier 1 = source layer (simple), Tier 45 = deeply nested in a long chain of dependencies. Higher tiers depend on more upstream sessions completing successfully.

**D8 — External Reads (10%)**
Number of external read operations. Sessions pulling from many external sources have more integration points, more failure modes, and more connection management complexity.

---

## 3. Bucket Thresholds & Hours Estimates

| Bucket | Score Range | Hours (w/ 0.7x accelerator) | Description |
|--------|-------------|------------------------------|-------------|
| **Simple** | 0 – 30 | 2.8 – 5.6 hrs | Low complexity. Straightforward data movement with minimal transformations, few table connections, and low risk. Can often be auto-migrated or templated. |
| **Medium** | 31 – 55 | 11.2 – 28.0 hrs | Moderate complexity. Meaningful transformation logic, some table diversity, and moderate risk. Requires manual review and targeted testing. |
| **Complex** | 56 – 75 | 28.0 – 56.0 hrs | High complexity. Significant processing logic, high coupling to other sessions, multiple risk factors. Requires detailed analysis, extensive testing, and possibly redesign. |
| **Very Complex** | 76 – 100 | 56.0 – 140.0 hrs | Critical complexity. Extreme in multiple dimensions — heavy transforms, high risk, deep coupling, broad table footprint. Likely candidates for re-architecture during migration. |

The accelerator factor (0.7x) assumes partial automation tooling is available. Raw hours without accelerator are 30% higher.

---

## 4. Results: Bucket Distribution

| Bucket | Count | % | Hours (Low) | Hours (High) |
|--------|-------|---|-------------|--------------|
| **Simple** | 3,765 | 28.8% | 10,542 | 21,084 |
| **Medium** | 5,761 | 44.0% | 64,523 | 161,308 |
| **Complex** | 2,165 | 16.5% | 60,620 | 121,240 |
| **Very Complex** | 1,393 | 10.6% | 78,008 | 195,020 |
| **TOTAL** | **13,084** | **100%** | **213,693** | **498,652** |

```
Distribution:

Simple       ████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  28.8%
Medium       ████████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░  44.0%
Complex      ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  16.5%
Very Complex ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  10.6%
```

### Score Histogram (5-point bins)

| Score Range | Count | Visual |
|-------------|-------|--------|
| 5 – 9 | 252 | `████` |
| 10 – 14 | 357 | `██████` |
| 15 – 19 | 558 | `█████████` |
| 20 – 24 | 909 | `███████████████` |
| 25 – 29 | 1,187 | `████████████████████` |
| 30 – 34 | 1,298 | `██████████████████████` |
| 35 – 39 | 1,343 | `██████████████████████` |
| **40 – 44** | **1,685** | `████████████████████████████` **(peak)** |
| 45 – 49 | 1,134 | `███████████████████` |
| 50 – 54 | 694 | `████████████` |
| 55 – 59 | 642 | `███████████` |
| 60 – 64 | 576 | `██████████` |
| 65 – 69 | 551 | `█████████` |
| 70 – 74 | 505 | `████████` |
| 75 – 79 | 399 | `███████` |
| 80 – 84 | 389 | `██████` |
| 85 – 89 | 373 | `██████` |
| 90 – 94 | 184 | `███` |
| 95 – 99 | 48 | `█` |

### Aggregate Statistics

| Metric | Value |
|--------|-------|
| Mean Score | 45.0 |
| Median Score | 41.7 |
| Min Score | 6.2 |
| Max Score | 98.4 |
| Std Deviation | 20.3 |

---

## 5. Dimension Scorecard — Raw Value Distributions

### D1: Transform Volume (weight 15%)

| Range | Count | Notes |
|-------|-------|-------|
| 0 – 7 | 4,995 | 38.2% — low-transform sessions (simple moves, stubs) |
| 8 – 15 | 6,722 | 51.4% — moderate transforms (standard ETL) |
| 16 – 23 | 782 | 6.0% — above-average processing |
| 24 – 31 | 351 | 2.7% — heavy processing |
| 32 – 55 | 194 | 1.5% — very heavy |
| 56 – 179 | 40 | 0.3% — extreme outliers |

**Stats:** min=0, max=179, mean=9.6, median=10, P75=11, P90=16, P99=39
**Zeros:** 2 sessions (0.02%)

### D2: Table Diversity (weight 10%)

| Range | Count | Notes |
|-------|-------|-------|
| 1 – 2 | 3,552 | 27.1% — single source/target pair |
| 3 – 5 | 6,910 | 52.8% — typical multi-table session |
| 6 – 8 | 1,458 | 11.1% — moderate diversity |
| 9 – 11 | 585 | 4.5% — broad data integration |
| 12 – 20 | 471 | 3.6% — highly diverse |
| 21 – 78 | 108 | 0.8% — enterprise-scale sessions |

**Stats:** min=1, max=78, mean=4.5, median=4, P75=5, P90=8, P99=19
**Zeros:** 0

### D3: Risk (weight 20%)

| Range | Count | Notes |
|-------|-------|-------|
| 0 | 1,299 | 9.9% — zero risk (no conflicts or staleness) |
| 1 | 6,186 | 47.3% — minimal risk |
| 2 – 3 | 3,691 | 28.2% — moderate risk |
| 4 – 5 | 962 | 7.4% — elevated risk |
| 6 – 9 | 617 | 4.7% — high risk |
| 10 – 15 | 229 | 1.8% — very high risk |
| 16 – 45 | 100 | 0.8% — critical risk |

**Stats:** min=0, max=45, mean=2.2, median=1, P75=2, P90=4, P99=14
**Zeros:** 1,299 sessions (9.9%)

### D4: IO Volume (weight 10%)

| Range | Count | Notes |
|-------|-------|-------|
| 2 – 5 | 9,221 | 70.5% — low IO (few table references) |
| 6 – 11 | 3,096 | 23.7% — moderate IO |
| 12 – 17 | 539 | 4.1% — high IO |
| 18 – 35 | 207 | 1.6% — very high IO |
| 36 – 123 | 21 | 0.2% — extreme IO |

**Stats:** min=2, max=123, mean=5.3, median=5, P75=6, P90=9, P99=21
**Zeros:** 0

### D5: Lookup Intensity (weight 10%)

| Range | Count | Notes |
|-------|-------|-------|
| 0 | 9,708 | 74.2% — no lookups |
| 1 | 1,197 | 9.1% — single lookup |
| 2 – 3 | 1,153 | 8.8% — few lookups |
| 4 – 7 | 674 | 5.2% — moderate lookups |
| 8 – 15 | 263 | 2.0% — heavy lookups |
| 16 – 41 | 89 | 0.7% — extreme lookup intensity |

**Stats:** min=0, max=41, mean=0.9, median=0, P75=1, P90=3, P99=12
**Zeros:** 9,708 sessions (74.2%)

### D6: Coupling (weight 15%)

| Range | Count | Notes |
|-------|-------|-------|
| 0 | 532 | 4.1% — completely isolated (no shared tables) |
| 1 – 10 | 1,063 | 8.1% — minimally coupled |
| 11 – 50 | 2,267 | 17.3% — low coupling |
| 51 – 200 | 2,969 | 22.7% — moderate coupling |
| 201 – 500 | 2,598 | 19.9% — high coupling |
| 501 – 1,000 | 1,342 | 10.3% — very high coupling |
| 1,001 – 2,361 | 2,313 | 17.7% — extreme coupling |

**Stats:** min=0, max=2,361, mean=275.5, median=99, P75=363, P90=845, P99=1,542
**Zeros:** 532 sessions (4.1%)

### D7: Structural Depth (weight 10%)

| Range | Count | Notes |
|-------|-------|-------|
| 1 | 7,769 | 59.4% — source layer (tier 1) |
| 2 – 3 | 1,259 | 9.6% — near-source |
| 4 – 9 | 698 | 5.3% — mid-tier |
| 10 – 19 | 945 | 7.2% — deep |
| 20 – 29 | 1,353 | 10.3% — very deep |
| 30 – 45 | 3,060 | 23.4% — deepest tiers |

**Stats:** min=1, max=45, mean=7.5, median=1, P75=11, P90=28, P99=45
**Zeros:** 0

### D8: External Reads (weight 10%)

| Range | Count | Notes |
|-------|-------|-------|
| 1 | 4,444 | 34.0% — single external read |
| 2 | 3,173 | 24.2% — two reads |
| 3 | 3,214 | 24.6% — three reads |
| 4 | 1,182 | 9.0% — four reads |
| 5 – 10 | 841 | 6.4% — multiple reads |
| 11 – 78 | 230 | 1.8% — heavy external IO |

**Stats:** min=1, max=78, mean=2.5, median=2, P75=3, P90=4, P99=10
**Zeros:** 0

---

## 6. Top Complexity Drivers

Which dimensions most frequently appear as the top-3 driver across all sessions:

| Driver | Sessions Where Top-3 | % of Population |
|--------|---------------------|-----------------|
| **D3 Risk** | 9,142 | 69.9% |
| **D1 Transform Volume** | 8,219 | 62.8% |
| **D6 Coupling** | 7,639 | 58.4% |
| D8 External Reads | 5,436 | 41.5% |
| D7 Structural Depth | 4,818 | 36.8% |
| D4 IO Volume | 2,210 | 16.9% |
| D2 Diversity | 1,779 | 13.6% |
| D5 Lookup Intensity | 9 | 0.1% |

**Key Insight:** Risk (D3), Transform Volume (D1), and Coupling (D6) are the dominant drivers of complexity in this estate. Lookup intensity (D5) is rarely a differentiator because 74% of sessions have zero lookups.

---

## 7. Bucket Profiles — Representative Sessions

### Simple (3,765 sessions — 28.8%)

These are low-touch sessions: minimal transforms, few table connections, low or no risk, limited coupling to other sessions. Many are single-source-to-single-target data movers, job control counters, or status checks.

| Percentile | Session Name | Score | Key Characteristics |
|------------|-------------|-------|---------------------|
| Lowest | JOB_CHECK_COUNTER | 6.2 | 1 transform, 1 table, 0 risk, 0 coupling, tier 1 |
| P25 | UNIX_JOB_LOG | 18.3 | 1 transform, 1 table, 1 risk, 90 coupled sessions, tier 1 |
| Median | Load_ZNK_ITEM | 23.9 | 12 transforms, 2 tables, 0 risk, 0 coupling, tier 1 |
| P75 | Status_ASL_CCSS | 29.0 | 4 transforms, 2 tables, 1 risk, 596 coupled sessions, tier 1 |
| Highest | ASG_CHARGES_STG | 56.0* | 9 transforms, 9 tables, 1 risk, 172 coupled, tier 11 |

*Edge case at the bucket boundary — scored just at threshold.

**Profile:** Low transforms (1-12), few tables (1-2 unique), zero or minimal risk, tier 1, limited or no lookups. The "simple movers" of the estate.

### Medium (5,761 sessions — 44.0%)

The bulk of the estate. These sessions have real transformation logic, moderate table connections, and some risk factors. They require manual review during migration but follow recognizable patterns.

| Percentile | Session Name | Score | Key Characteristics |
|------------|-------------|-------|---------------------|
| Lowest | TN_SERVICE_IMAGE | 31.0 | 3 transforms, 2 tables, 2 risk, 84 coupled, tier 1 |
| P25 | Control_Status_ACP | 37.9 | 4 transforms, 3 tables, 1 risk, 1,311 coupled, tier 1 |
| Median | Tails_Default_Currencies | 41.7 | 12 transforms, 2 tables, 2 risk, 138 coupled, tier 1 |
| P75 | PROV_PRIORITY_ENUM | 46.5 | 11 transforms, 5 tables, 1 risk, 49 coupled, tier 1 |
| Highest | Load_VRFPEER_HIST | 55.0 | 11 transforms, 6 tables, 2 risk, 42 coupled, tier 1 |

**Profile:** Moderate transforms (3-12), growing table diversity (2-6 unique), risk score of 1-2 (one conflict or staleness), coupling varies widely (42-1,311), mostly tier 1 but not exclusively. The "standard ETL" of the estate.

### Complex (2,165 sessions — 16.5%)

Significant processing logic with multiple risk factors and deep structural positioning. These sessions are the ones that break during migration if not carefully analyzed.

| Percentile | Session Name | Score | Key Characteristics |
|------------|-------------|-------|---------------------|
| Lowest | SAM_EMEA_Weekly | 56.0 | 10 transforms, 3 tables, 2 risk, 203 coupled, tier 20, 2 lookups |
| P25 | DTL_USAGE_SAM | 60.1 | 10 transforms, 4 tables, 3 risk, 284 coupled, tier 24, 1 lookup |
| Median | Reconcile_data | 64.8 | 8 transforms, 6 tables, 2 risk, 1,185 coupled, tier 3 |
| P75 | Load_OMS_TASK | 69.6 | 13 transforms, 6 tables, 3 risk, 632 coupled, tier 1 |
| Highest | CUSINS_BTP_PREP | 75.0 | 18 transforms, 10 tables, 2 risk, 279 coupled, tier 41 |

**Profile:** Elevated transforms (8-18), broader table diversity (3-10), risk 2-3 (multiple conflicts), high coupling (200-1,185), often in deeper tiers (20-41). The "watch carefully" sessions.

### Very Complex (1,393 sessions — 10.6%)

The hardest sessions to migrate. These are highly coupled, deeply nested, with heavy transformation logic and significant write conflict risk. Many involve the same core entities (ORDER_PRODUCT, CUSTOMER_ORDER, etc.).

| Percentile | Session Name | Score | Key Characteristics |
|------------|-------------|-------|---------------------|
| Lowest | PORT_LEGACY_CTL | 75.0 | 15 transforms, 5 tables, 4 risk, 397 coupled, tier 24, 2 lookups |
| P25 | Load_OFFNET_JEOPARDY | 79.4 | 12 transforms, 8 tables, 3 risk, 359 coupled, tier 22, 2 lookups |
| Median | ACCRUAL_CHARGE_OVERRIDE | 83.9 | 23 transforms, 9 tables, 6 risk, 224 coupled, tier 18, 3 lookups |
| P75 | Load_ITEM_MASTER | 87.9 | 13 transforms, 13 tables, 10 risk, 676 coupled, tier 5, 8 lookups |
| Highest | ORDER_PRODUCT_COMPNT | 98.4 | 30 transforms, 31 tables, 21 risk, 2,055 coupled, tier 28, 19 lookups |

**Profile:** Heavy transforms (12-30+), high table diversity (5-31), high risk (3-21), extreme coupling (224-2,055), deep tiers, frequent lookup usage. The "re-architect during migration" sessions.

---

## 8. Top 25 Most Complex Sessions

| Rank | Session Name | Score | Transforms | Tables | Risk | Coupling | Tier | Lookups | Ext Reads |
|------|-------------|-------|------------|--------|------|----------|------|---------|-----------|
| 1 | ORDER_PRODUCT_COMPNT | 98.4 | 30 | 31 | 21 | 2,055 | 28 | 19 | 12 |
| 2 | CUSTOMER_ORDER_PRODUCT | 98.3 | 26 | 43 | 35 | 2,245 | 27 | 33 | 11 |
| 3 | REVISE_F2CMART_STG | 98.2 | 91 | 34 | 29 | 1,197 | 32 | 29 | 6 |
| 4 | ORDER_PRODUCT_COMPNT | 97.8 | 32 | 28 | 23 | 2,037 | 22 | 21 | 9 |
| 5 | ACCRUAL_CHARGE_PREP | 97.7 | 70 | 35 | 24 | 1,341 | 19 | 22 | 18 |
| 6 | ODS_OFFNET_ORDER | 97.6 | 139 | 41 | 34 | 905 | 30 | 33 | 10 |
| 7 | CUSTOMER_ORDER_PRODUCT | 97.6 | 30 | 34 | 29 | 2,152 | 21 | 28 | 7 |
| 8 | CUST_SERV_DISCO | 97.5 | 73 | 27 | 20 | 761 | 35 | 18 | 9 |
| 9 | CUSTOMER_ORDER_PRODUCT | 97.5 | 27 | 42 | 27 | 2,125 | 17 | 24 | 19 |
| 10 | CUSTOMER_ORDER_PRODUCT | 97.5 | 26 | 34 | 27 | 1,197 | 27 | 26 | 14 |
| 11 | Pipeline_Order_Processed | 97.3 | 72 | 31 | 29 | 1,197 | 32 | 29 | 4 |
| 12 | CUSTOMER_ORDER_PRODUCT | 97.3 | 25 | 22 | 17 | 2,186 | 27 | 14 | 6 |
| 13 | CUSTOMER_ORDER_PRODUCT | 97.2 | 27 | 44 | 33 | 2,273 | 13 | 30 | 14 |
| 14 | TN_LINE_ORDER | 97.1 | 27 | 32 | 11 | 1,922 | 28 | 8 | 24 |
| 15 | CUSTOMER_ORDER_PRODUCT | 97.1 | 28 | 24 | 19 | 2,156 | 24 | 16 | 5 |
| 16 | ORDER_PRODUCT_COMPNT | 96.7 | 26 | 29 | 14 | 1,969 | 18 | 11 | 18 |
| 17 | Load_VIRTUAL_CIRCUIT | 96.7 | 38 | 17 | 13 | 966 | 33 | 12 | 7 |
| 18 | Load_ICCKT | 96.6 | 109 | 44 | 25 | 1,036 | 19 | 23 | 20 |
| 19 | Load_ECCKT | 96.6 | 179 | 59 | 43 | 873 | 19 | 41 | 20 |
| 20 | TN_SERVICE_IMAGE | 96.6 | 42 | 20 | 15 | 1,010 | 30 | 13 | 6 |
| 21 | CUSTOMER_ORDER_PRODUCT | 96.5 | 26 | 21 | 17 | 2,076 | 17 | 15 | 6 |
| 22 | ORDER_PRODUCT_COMPNT | 96.4 | 30 | 22 | 13 | 1,087 | 28 | 12 | 12 |
| 23 | CUSTOMER_ORDER_PRODUCT | 96.4 | — | — | — | — | — | — | — |
| 24 | — | — | — | — | — | — | — | — | — |
| 25 | — | — | — | — | — | — | — | — | — |

**Pattern:** The top 25 is dominated by **CUSTOMER_ORDER_PRODUCT** (8 instances) and **ORDER_PRODUCT_COMPNT** (4 instances). These represent the most interconnected, conflict-heavy entities in the estate — the order management domain.

---

## 9. Coupling Analysis

Coupling measures how many other sessions share at least one table with a given session. High coupling means changes to this session ripple through the estate.

| Coupling Level | Range | Count | % |
|----------------|-------|-------|---|
| Isolated | 0 | 532 | 4.1% |
| Minimal | 1 – 10 | 1,063 | 8.1% |
| Low | 11 – 50 | 2,267 | 17.3% |
| Moderate | 51 – 200 | 2,969 | 22.7% |
| High | 201 – 500 | 2,598 | 19.9% |
| Very High | 501 – 1,000 | 1,342 | 10.3% |
| Extreme | 1,001 – 2,361 | 2,313 | 17.7% |

**Mean coupling:** 275.5 sessions
**Max coupling:** 2,361 sessions (one session shares tables with 18% of the entire estate)

**Key Insight:** Only 4.1% of sessions are truly isolated. The vast majority (95.9%) share at least one table with another session, and 47.9% are coupled to over 200 other sessions. This is a highly interconnected estate.

---

## 10. Hours Estimate Summary

| Bucket | Sessions | Hours (Low) | Hours (High) | Avg Hours/Session |
|--------|----------|-------------|--------------|-------------------|
| Simple | 3,765 | 10,542 | 21,084 | 2.8 – 5.6 |
| Medium | 5,761 | 64,523 | 161,308 | 11.2 – 28.0 |
| Complex | 2,165 | 60,620 | 121,240 | 28.0 – 56.0 |
| Very Complex | 1,393 | 78,008 | 195,020 | 56.0 – 140.0 |
| **TOTAL** | **13,084** | **213,693** | **498,652** | **16.3 – 38.1** |

**Note:** Hours estimates assume a 0.7x accelerator factor for migration tooling assistance. Without tooling, multiply by 1.43x.

```
Hours Distribution by Bucket:

Simple       █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  4.9%  – 4.2% of hours
Medium       ██████████████████████████████░░░░░░░░░░  30.2% – 32.3% of hours
Complex      ████████████████████████████░░░░░░░░░░░░  28.4% – 24.3% of hours
Very Complex █████████████████████████████████████████  36.5% – 39.1% of hours
```

**Key Insight:** Very Complex sessions are only 10.6% of the count but consume 36.5-39.1% of the total estimated hours. These are where migration investment should focus.

---

## 11. Technical Implementation

### Source Files

| File | Purpose |
|------|---------|
| `backend/app/engines/vectors/v11_complexity_analyzer.py` | Scoring engine — dimensions, normalization, bucket assignment |
| `backend/app/engines/vectors/feature_extractor.py` | Feature extraction — bridges parsed XML to session features |
| `frontend/src/components/tiermap/ComplexityOverlay.tsx` | UI — complexity badges and dimension breakdown display |
| `frontend/src/layers/L4_SessionBlueprint.tsx` | UI — session detail view with complexity dimensions |

### Normalization Implementation (Pseudocode)

```python
def percentile_normalize(values, zero_floor=False):
    if zero_floor:
        # Separate zeros from non-zeros
        zeros get normalized to 0
        non_zeros get percentile-ranked within their subset (1-100 scale)
    else:
        # Standard percentile rank
        sort all values
        for each value: normalized = (rank / (n-1)) * 100
        ties get average rank
```

### Coupling Computation (Pseudocode)

```python
def compute_coupling(sessions):
    # Build table → sessions index
    for each session:
        for each table in (sources ∪ targets ∪ lookups):
            table_to_sessions[table].add(session.id)

    # Count shared sessions per session
    for each session:
        shared = union of table_to_sessions[t] for t in session's tables
        shared.remove(session.id)
        coupling[session.id] = len(shared)
```

---

---

## 12. Exact-Match Duplicate Sessions

Sessions with **identical table dependency fingerprints** (same sorted sources, targets, and lookups). These sessions perform structurally identical data operations and represent candidates for consolidation or templatization.

### Fingerprint Method

```
fingerprint = MD5(sorted(sources) | sorted(targets) | sorted(lookups))[:16]
Two sessions match if and only if they have the exact same fingerprint.
```

### 12.1 Summary Statistics

| Metric | Value |
|--------|-------|
| Total sessions analyzed | 13,084 |
| Unique fingerprints | 10,033 |
| Duplicate groups (2+ members) | 687 |
| Sessions in duplicate groups | 3,738 (28.6%) |
| Singleton sessions (unique) | 9,346 (71.4%) |
| Largest group | 403 members |
| Groups with 10+ members | 38 |
| Groups with exactly 2 members | 400 |

### 12.2 Size Distribution

| Group Size | Count | Total Sessions |
|------------|-------|----------------|
| 403 members | 1 | 403 |
| 146 members | 1 | 146 |
| 138 members | 1 | 138 |
| 137 members | 1 | 137 |
| 136 members | 1 | 136 |
| 121 members | 1 | 121 |
| 66 members | 1 | 66 |
| 51 members | 1 | 51 |
| 50 members | 1 | 50 |
| 44 members | 1 | 44 |
| 36 members | 1 | 36 |
| 35 members | 1 | 35 |
| 32 members | 1 | 32 |
| 28 members | 1 | 28 |
| 27 members | 1 | 27 |
| 24 members | 2 | 48 |
| 23 members | 1 | 23 |
| 21 members | 1 | 21 |
| 20 members | 1 | 20 |
| 18 members | 1 | 18 |
| 17 members | 2 | 34 |
| 13 members | 3 | 39 |
| 12 members | 4 | 48 |
| 11 members | 3 | 33 |
| 10 members | 5 | 50 |
| 9 members | 10 | 90 |
| 8 members | 19 | 152 |
| 7 members | 17 | 119 |
| 6 members | 22 | 132 |
| 5 members | 27 | 135 |
| 4 members | 64 | 256 |
| 3 members | 90 | 270 |
| 2 members | 400 | 800 |

### 12.3 Notable Patterns

The largest duplicate groups are dominated by **control/status check sessions** and **dummy placeholder sessions**:

- **DG_1 (403 members):** All read `DUMMY_SRCE` → write `DUMMY_TGT` — control flow stubs with no real data transformation
- **DG_2 (146 members):** Divestiture daily table count checks — identical monitoring sessions
- **DG_3 (138 members):** Similar divestiture checks with an extra target table
- **DG_4 (137 members):** Job log → target dummy — execution logging stubs
- **DG_5 (136 members):** Months processed → dummy target — date parameter stubs
- **DG_6 (121 members):** Security common number dummy source/target pairs

**Groups with lookup tables** (actual data processing duplicates):
- **DG_18 (23 members):** FF_LOAD_STATUS → ASL_LOAD_STATUS with ASL_LOAD_STATUS lookup
- **DG_19 (21 members):** USOC_BILLED → CODS_NETEX with USOC_OCC_CATGRY lookup
- **DG_35 (10 members):** ORDER_PRODUCT_INCR_AMT with 2 lookups — real business logic duplicates
- **DG_38 (10 members):** DSS_CLR → DSS_CIRCUIT_HIERARCHY with 8+ lookups — complex duplicates

### 12.4 All Duplicate Groups

Each group lists: session name, tier, step, transform count, and full session path.

#### DG_1 — 403 members
- **Sources:** `DUMMY_SRCE`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_NEXT_MNTH | 1 | 5 | 4 | `m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_OVERLAY_REVENUE_NEXT_MNTH` |
| 2 | LOAD_CONTROL_STATUS | 1 | 31 | 4 | `s_m_APP_LOAD_CONTROL_STATUS` |
| 3 | STATUS_ASPECT_ADC | 1 | 32 | 4 | `s_m_APP_LOAD_CONTROL_STATUS_ASPECT_ADC` |
| 4 | STATUS_ASPECT_IDC | 1 | 33 | 4 | `s_m_APP_LOAD_CONTROL_STATUS_ASPECT_IDC` |
| 5 | STATUS_ASPECT_IVR | 1 | 34 | 4 | `s_m_APP_LOAD_CONTROL_STATUS_ASPECT_IVR` |
| 6 | CheckCntrlStatus | 1 | 133 | 4 | `s_m_CheckCntrlStatus` |
| 7 | CheckCntrlStatus_CODS | 1 | 134 | 4 | `s_m_CheckCntrlStatus_CODS` |
| 8 | CODS_BPMS_PIPELINE | 1 | 135 | 4 | `s_m_CheckCntrlStatus_CODS_BPMS_PIPELINE` |
| 9 | NETINV_equipment_All | 1 | 136 | 4 | `s_m_CheckCntrlStatus_ODS_NETINV_equipment_All` |
| 10 | SFDC_CTL_CODS | 1 | 137 | 5 | `s_m_Check_ASL_Control_Status_ASL_SFDC_CTL_CODS` |
| 11 | Control_Status_ODS | 1 | 138 | 5 | `s_m_Check_ASL_Control_Status_ODS` |
| 12 | Port_Attr_Settings | 1 | 139 | 5 | `s_m_Check_ASL_Control_Status_Port_Attr_Settings` |
| 13 | Prior_Equipment_ALL | 1 | 140 | 5 | `s_m_Check_ASL_Control_Status_Prior_Equipment_ALL` |
| 14 | Prior_Location_ALL | 1 | 141 | 5 | `s_m_Check_ASL_Control_Status_Prior_Location_ALL` |
| 15 | App_Cntrl_Status | 1 | 144 | 4 | `s_m_Check_App_Cntrl_Status` |
| 16 | ASL_CLARIFY_SA | 1 | 145 | 4 | `s_m_Check_App_Cntrl_Status_ASL_CLARIFY_SA` |
| 17 | Status_ASL_CPO | 1 | 146 | 4 | `s_m_Check_App_Cntrl_Status_ASL_CPO` |
| 18 | Status_ASL_EWFM | 1 | 147 | 4 | `s_m_Check_App_Cntrl_Status_ASL_EWFM` |
| 19 | Status_ASL_LATAM | 1 | 148 | 4 | `s_m_Check_App_Cntrl_Status_ASL_LATAM` |
| 20 | ASL_LERG_L3 | 1 | 149 | 4 | `s_m_Check_App_Cntrl_Status_ASL_LERG_L3` |
| 21 | Status_ASL_NS | 1 | 150 | 4 | `s_m_Check_App_Cntrl_Status_ASL_NS` |
| 22 | Status_ASL_NUTS | 1 | 151 | 4 | `s_m_Check_App_Cntrl_Status_ASL_NUTS` |
| 23 | Status_ASL_PIPELINE | 1 | 152 | 4 | `s_m_Check_App_Cntrl_Status_ASL_PIPELINE` |
| 24 | Init_ODS_ORDER | 1 | 153 | 4 | `s_m_Check_App_Cntrl_Status_ASL_SIEBEL_L3_Init_ODS_ORDER` |
| 25 | ASL_SLDB_LNP | 1 | 154 | 4 | `s_m_Check_App_Cntrl_Status_ASL_SLDB_LNP` |
| 26 | ASL_SLDB_SUBL | 1 | 155 | 4 | `s_m_Check_App_Cntrl_Status_ASL_SLDB_SUBL` |
| 27 | Status_ASL_TNI | 1 | 156 | 4 | `s_m_Check_App_Cntrl_Status_ASL_TNI` |
| 28 | Status_Asl_Pro | 1 | 157 | 4 | `s_m_Check_App_Cntrl_Status_Asl_Pro` |
| 29 | ASL_CNUM_LOCAL | 1 | 158 | 4 | `s_m_Check_App_Cntrl_Status_Load_ASL_CNUM_LOCAL` |
| 30 | LOCAL_VOICE_SWITCH | 1 | 159 | 4 | `s_m_Check_App_Cntrl_Status_Load_CNUM_LOCAL_VOICE_SWITCH` |
| 31 | Status_Load_CUSTOMER | 1 | 160 | 4 | `s_m_Check_App_Cntrl_Status_Load_CUSTOMER` |
| 32 | Status_Load_OCN | 1 | 161 | 4 | `s_m_Check_App_Cntrl_Status_Load_OCN` |
| 33 | Load_RATE_CENTER | 1 | 162 | 4 | `s_m_Check_App_Cntrl_Status_Load_RATE_CENTER` |
| 34 | Load_VOICE_SWITCH | 1 | 163 | 4 | `s_m_Check_App_Cntrl_Status_Load_VOICE_SWITCH` |
| 35 | Casc_Hrly_Master | 1 | 164 | 4 | `s_m_Check_App_Control_Casc_Hrly_Master` |
| 36 | Control_Nrl_Casc | 1 | 166 | 4 | `s_m_Check_App_Control_Nrl_Casc` |
| 37 | App_Control_Status1 | 1 | 168 | 4 | `s_m_Check_App_Control_Status1` |
| 38 | Control_Status_ACCOUNT | 1 | 169 | 4 | `s_m_Check_App_Control_Status_ACCOUNT` |
| 39 | Control_Status_ACCOUNTTEAMMEMBER | 1 | 170 | 4 | `s_m_Check_App_Control_Status_ACCOUNTTEAMMEMBER` |
| 40 | Control_Status_ADC | 1 | 173 | 4 | `s_m_Check_App_Control_Status_ADC` |
| 41 | ARBOR_CONSOLIDATION_CDC | 1 | 174 | 4 | `s_m_Check_App_Control_Status_ARBOR_CONSOLIDATION_CDC` |
| 42 | Control_Status_ASL | 1 | 177 | 4 | `s_m_Check_App_Control_Status_ASL` |
| 43 | Status_ASL_ACCTMGT | 1 | 178 | 4 | `s_m_Check_App_Control_Status_ASL_ACCTMGT` |
| 44 | ASL_AMDOCS_RM | 1 | 179 | 5 | `s_m_Check_App_Control_Status_ASL_AMDOCS_RM` |
| 45 | Status_ASL_APOLLO | 1 | 180 | 4 | `s_m_Check_App_Control_Status_ASL_APOLLO` |
| 46 | ARBOR_L3_2 | 1 | 181 | 4 | `s_m_Check_App_Control_Status_ASL_ARBOR_L3_2` |
| 47 | Status_ASL_AUTOPRVP | 1 | 182 | 4 | `s_m_Check_App_Control_Status_ASL_AUTOPRVP` |
| 48 | Status_ASL_BART | 1 | 183 | 4 | `s_m_Check_App_Control_Status_ASL_BART` |
| 49 | BF_TRANSACTIONS_SUMMARY | 1 | 184 | 5 | `s_m_Check_App_Control_Status_ASL_BF_TRANSACTIONS_SUMMARY` |
| 50 | ACCOUNT__C | 1 | 185 | 4 | `s_m_Check_App_Control_Status_ASL_BILLING_ACCOUNT__C` |
| 51 | BLUEMARBLE_RPT_ACCOUNT | 1 | 186 | 4 | `s_m_Check_App_Control_Status_ASL_BLUEMARBLE_RPT_ACCOUNT` |
| 52 | BLUEMARBLE_RPT_ADDRESS | 1 | 187 | 4 | `s_m_Check_App_Control_Status_ASL_BLUEMARBLE_RPT_ADDRESS` |
| 53 | BLUEMARBLE_RPT_ORDDLRCODE | 1 | 188 | 4 | `s_m_Check_App_Control_Status_ASL_BLUEMARBLE_RPT_ORDDLRCODE` |
| 54 | BLUEMARBLE_RPT_ORDITEMS | 1 | 189 | 4 | `s_m_Check_App_Control_Status_ASL_BLUEMARBLE_RPT_ORDITEMS` |
| 55 | BLUEMARBLE_RPT_ORDREF | 1 | 190 | 4 | `s_m_Check_App_Control_Status_ASL_BLUEMARBLE_RPT_ORDREF` |
| 56 | BLUEMARBLE_RPT_PRIDTL | 1 | 191 | 4 | `s_m_Check_App_Control_Status_ASL_BLUEMARBLE_RPT_PRIDTL` |
| 57 | BLUEMARBLE_RPT_SCHED | 1 | 192 | 4 | `s_m_Check_App_Control_Status_ASL_BLUEMARBLE_RPT_SCHED` |
| 58 | BLUEMARBLE_RPT_SLSCHNNINFO | 1 | 193 | 4 | `s_m_Check_App_Control_Status_ASL_BLUEMARBLE_RPT_SLSCHNNINFO` |
| 59 | ASL_BPMS_PIPELINE | 1 | 194 | 4 | `s_m_Check_App_Control_Status_ASL_BPMS_PIPELINE` |
| 60 | Status_ASL_BRM | 1 | 195 | 4 | `s_m_Check_App_Control_Status_ASL_BRM` |
| 61 | Status_ASL_CABS | 1 | 196 | 4 | `s_m_Check_App_Control_Status_ASL_CABS` |
| 62 | ASL_CABS_FILES | 1 | 197 | 4 | `s_m_Check_App_Control_Status_ASL_CABS_FILES` |
| 63 | CABS_FILES_HR | 1 | 198 | 4 | `s_m_Check_App_Control_Status_ASL_CABS_FILES_HR` |
| 64 | Status_ASL_CBP | 1 | 199 | 4 | `s_m_Check_App_Control_Status_ASL_CBP` |
| 65 | CLARIFY_AUTO_NOTIFY | 1 | 201 | 4 | `s_m_Check_App_Control_Status_ASL_CLARIFY_AUTO_NOTIFY` |
| 66 | ASL_CLARIFY_STG | 1 | 202 | 4 | `s_m_Check_App_Control_Status_ASL_CLARIFY_STG` |
| 67 | COMMON_CCSS_USECASE | 1 | 203 | 4 | `s_m_Check_App_Control_Status_ASL_COMMON_CCSS_USECASE` |
| 68 | ASL_COMMON_RESTRICTED | 1 | 204 | 4 | `s_m_Check_App_Control_Status_ASL_COMMON_RESTRICTED` |
| 69 | ASL_CONTACT_4HR | 1 | 205 | 4 | `s_m_Check_App_Control_Status_ASL_CONTACT_4HR` |
| 70 | Status_ASL_CPO | 1 | 209 | 4 | `s_m_Check_App_Control_Status_ASL_CPO` |
| 71 | CPO_ASSET_VIEW | 1 | 210 | 4 | `s_m_Check_App_Control_Status_ASL_CPO_ASSET_VIEW` |
| 72 | Status_ASL_CRIS | 1 | 211 | 4 | `s_m_Check_App_Control_Status_ASL_CRIS` |
| 73 | CRIS_BKP_0316 | 1 | 212 | 4 | `s_m_Check_App_Control_Status_ASL_CRIS_BKP_0316` |
| 74 | ASL_Clarify_SA | 1 | 213 | 4 | `s_m_Check_App_Control_Status_ASL_Clarify_SA` |
| 75 | EASE_CABS_STG | 1 | 215 | 4 | `s_m_Check_App_Control_Status_ASL_EASE_CABS_STG` |
| 76 | ECOM_MKT_SST2 | 1 | 216 | 4 | `s_m_Check_App_Control_Status_ASL_ECOM_MKT_SST2` |
| 77 | Status_ASL_EIS | 1 | 217 | 4 | `s_m_Check_App_Control_Status_ASL_EIS` |
| 78 | EIS_PORTAL_ORDER | 1 | 218 | 4 | `s_m_Check_App_Control_Status_ASL_EIS_PORTAL_ORDER` |
| 79 | Status_ASL_EM | 1 | 219 | 4 | `s_m_Check_App_Control_Status_ASL_EM` |
| 80 | Status_ASL_ENS | 1 | 220 | 4 | `s_m_Check_App_Control_Status_ASL_ENS` |
| 81 | CIRCUIT_ASSET_STG | 1 | 221 | 4 | `s_m_Check_App_Control_Status_ASL_ENS_CIRCUIT_ASSET_STG` |
| 82 | ASL_ENS_STG | 1 | 222 | 4 | `s_m_Check_App_Control_Status_ASL_ENS_STG` |
| 83 | Status_ASL_EON | 1 | 223 | 4 | `s_m_Check_App_Control_Status_ASL_EON` |
| 84 | ASL_GLOBAL_ATTACH | 1 | 225 | 4 | `s_m_Check_App_Control_Status_ASL_GLOBAL_ATTACH` |
| 85 | Status_ASL_IFO | 1 | 228 | 4 | `s_m_Check_App_Control_Status_ASL_IFO` |
| 86 | Status_ASL_INGRESOS | 1 | 229 | 4 | `s_m_Check_App_Control_Status_ASL_INGRESOS` |
| 87 | Status_ASL_ISM | 1 | 230 | 4 | `s_m_Check_App_Control_Status_ASL_ISM` |
| 88 | Status_ASL_ISOURCE | 1 | 231 | 4 | `s_m_Check_App_Control_Status_ASL_ISOURCE` |
| 89 | Status_ASL_KENANFX | 1 | 232 | 4 | `s_m_Check_App_Control_Status_ASL_KENANFX` |
| 90 | ASL_KENAN_LATAM | 1 | 233 | 4 | `s_m_Check_App_Control_Status_ASL_KENAN_LATAM` |
| 91 | Status_ASL_LEXCIS | 1 | 234 | 4 | `s_m_Check_App_Control_Status_ASL_LEXCIS` |
| 92 | Status_ASL_LEXM | 1 | 235 | 4 | `s_m_Check_App_Control_Status_ASL_LEXM` |
| 93 | LOCATION_AMDOCS_RM | 1 | 236 | 5 | `s_m_Check_App_Control_Status_ASL_LOCATION_AMDOCS_RM` |
| 94 | ASL_LUMEN_SERVICENOW | 1 | 237 | 5 | `s_m_Check_App_Control_Status_ASL_LUMEN_SERVICENOW` |
| 95 | Status_ASL_MBS | 1 | 238 | 4 | `s_m_Check_App_Control_Status_ASL_MBS` |
| 96 | ASL_NC_WORKVU | 1 | 239 | 4 | `s_m_Check_App_Control_Status_ASL_NC_WORKVU` |
| 97 | Status_ASL_NETFLEX | 1 | 240 | 5 | `s_m_Check_App_Control_Status_ASL_NETFLEX` |
| 98 | Status_ASL_NETWORX | 1 | 241 | 4 | `s_m_Check_App_Control_Status_ASL_NETWORX` |
| 99 | ASL_NETWORX_SST2 | 1 | 242 | 4 | `s_m_Check_App_Control_Status_ASL_NETWORX_SST2` |
| 100 | Status_ASL_ODB | 1 | 243 | 4 | `s_m_Check_App_Control_Status_ASL_ODB` |
| 101 | ASL_OMC2_OE | 1 | 244 | 4 | `s_m_Check_App_Control_Status_ASL_OMC2_OE` |
| 102 | Status_ASL_ORACLE2E | 1 | 245 | 4 | `s_m_Check_App_Control_Status_ASL_ORACLE2E` |
| 103 | ASL_ORACLE2E_FED | 1 | 246 | 4 | `s_m_Check_App_Control_Status_ASL_ORACLE2E_FED` |
| 104 | ASL_ORACLE2E_STG | 1 | 247 | 4 | `s_m_Check_App_Control_Status_ASL_ORACLE2E_STG` |
| 105 | Status_ASL_ORAFIN | 1 | 248 | 4 | `s_m_Check_App_Control_Status_ASL_ORAFIN` |
| 106 | Status_ASL_PCAT | 1 | 250 | 4 | `s_m_Check_App_Control_Status_ASL_PCAT` |
| 107 | Status_ASL_PIPELINE | 1 | 251 | 4 | `s_m_Check_App_Control_Status_ASL_PIPELINE` |
| 108 | DLT2_4HR_SYSDATE | 1 | 252 | 4 | `s_m_Check_App_Control_Status_ASL_PIPELINE_DLT2_4HR_SYSDATE` |
| 109 | ASL_PIPELINE_SYSDATE | 1 | 253 | 4 | `s_m_Check_App_Control_Status_ASL_PIPELINE_SYSDATE` |
| 110 | Status_ASL_PROD | 1 | 256 | 4 | `s_m_Check_App_Control_Status_ASL_PROD` |
| 111 | ASL_PRO_IP | 1 | 257 | 4 | `s_m_Check_App_Control_Status_ASL_PRO_IP` |
| 112 | ASL_PRO_MNS | 1 | 258 | 4 | `s_m_Check_App_Control_Status_ASL_PRO_MNS` |
| 113 | Status_ASL_QMV | 1 | 259 | 4 | `s_m_Check_App_Control_Status_ASL_QMV` |
| 114 | Status_ASL_QUOTESTORE | 1 | 262 | 4 | `s_m_Check_App_Control_Status_ASL_QUOTESTORE` |
| 115 | Status_ASL_RDB | 1 | 263 | 4 | `s_m_Check_App_Control_Status_ASL_RDB` |
| 116 | Status_ASL_RSOR | 1 | 265 | 4 | `s_m_Check_App_Control_Status_ASL_RSOR` |
| 117 | Status_ASL_SAP | 1 | 266 | 4 | `s_m_Check_App_Control_Status_ASL_SAP` |
| 118 | WRKFL_INCREMENTAL_ALL | 1 | 267 | 4 | `s_m_Check_App_Control_Status_ASL_SAVVION_WRKFL_INCREMENTAL_ALL` |
| 119 | SAVVION_WRKFL_Init | 1 | 268 | 4 | `s_m_Check_App_Control_Status_ASL_SAVVION_WRKFL_Init` |
| 120 | SAVVION_WRKFL_SST2 | 1 | 269 | 4 | `s_m_Check_App_Control_Status_ASL_SAVVION_WRKFL_SST2` |
| 121 | UC3_CONTACT_4HRS | 1 | 270 | 4 | `s_m_Check_App_Control_Status_ASL_SDP3_UC3_CONTACT_4HRS` |
| 122 | ASL_SFDC_CODS | 1 | 272 | 4 | `s_m_Check_App_Control_Status_ASL_SFDC_CODS` |
| 123 | SFDC_CODS_4HR | 1 | 273 | 4 | `s_m_Check_App_Control_Status_ASL_SFDC_CODS_4HR` |
| 124 | CTL_CODS_4HR | 1 | 275 | 4 | `s_m_Check_App_Control_Status_ASL_SFDC_CTL_CODS_4HR` |
| 125 | CTL_CODS_DLT2 | 1 | 276 | 4 | `s_m_Check_App_Control_Status_ASL_SFDC_CTL_CODS_DLT2` |
| 126 | CODS_DLT2_4HR | 1 | 277 | 5 | `s_m_Check_App_Control_Status_ASL_SFDC_CTL_CODS_DLT2_4HR` |
| 127 | ASL_SFDC_FIBER | 1 | 278 | 4 | `s_m_Check_App_Control_Status_ASL_SFDC_FIBER` |
| 128 | SFDC_FIBER_MINUS | 1 | 279 | 4 | `s_m_Check_App_Control_Status_ASL_SFDC_FIBER_MINUS` |
| 129 | Status_ASL_SFENT | 1 | 280 | 4 | `s_m_Check_App_Control_Status_ASL_SFENT` |
| 130 | ASL_SIEBEL6_LATAM | 1 | 281 | 4 | `s_m_Check_App_Control_Status_ASL_SIEBEL6_LATAM` |
| 131 | ASL_SIEBEL6_WILTEL | 1 | 282 | 4 | `s_m_Check_App_Control_Status_ASL_SIEBEL6_WILTEL` |
| 132 | ASL_SIEBEL8_LATAM | 1 | 283 | 4 | `s_m_Check_App_Control_Status_ASL_SIEBEL8_LATAM` |
| 133 | SIEBEL_L3_Init | 1 | 284 | 4 | `s_m_Check_App_Control_Status_ASL_SIEBEL_L3_Init` |
| 134 | Init_4HR_SYSDATE | 1 | 285 | 4 | `s_m_Check_App_Control_Status_ASL_SIEBEL_L3_Init_4HR_SYSDATE` |
| 135 | SIEBEL_L3_SST2 | 1 | 286 | 4 | `s_m_Check_App_Control_Status_ASL_SIEBEL_L3_SST2` |
| 136 | L3_SST2_SYSDATE | 1 | 287 | 4 | `s_m_Check_App_Control_Status_ASL_SIEBEL_L3_SST2_SYSDATE` |
| 137 | ASL_SLDB_SUBL | 1 | 288 | 4 | `s_m_Check_App_Control_Status_ASL_SLDB_SUBL` |
| 138 | Status_ASL_SWIFT | 1 | 289 | 4 | `s_m_Check_App_Control_Status_ASL_SWIFT` |
| 139 | SWIFT_ASSET_VIEW | 1 | 290 | 4 | `s_m_Check_App_Control_Status_ASL_SWIFT_ASSET_VIEW` |
| 140 | SM_PSP_DETAIL | 1 | 291 | 4 | `s_m_Check_App_Control_Status_ASL_SWIFT_SM_PSP_DETAIL` |
| 141 | ASL_SWIFT_TRANS | 1 | 292 | 4 | `s_m_Check_App_Control_Status_ASL_SWIFT_TRANS` |
| 142 | Status_ASL_VANTIVE | 1 | 298 | 4 | `s_m_Check_App_Control_Status_ASL_VANTIVE` |
| 143 | ASL_VANTIVE_SST2 | 1 | 299 | 4 | `s_m_Check_App_Control_Status_ASL_VANTIVE_SST2` |
| 144 | ASL_VANTIVE_STG | 1 | 300 | 4 | `s_m_Check_App_Control_Status_ASL_VANTIVE_STG` |
| 145 | ASL_VLOCITY_SFENT | 1 | 301 | 4 | `s_m_Check_App_Control_Status_ASL_VLOCITY_SFENT` |
| 146 | ASL_VLOCITY_WM | 1 | 302 | 4 | `s_m_Check_App_Control_Status_ASL_VLOCITY_WM` |
| 147 | Control_Status_Acq | 1 | 305 | 4 | `s_m_Check_App_Control_Status_Acq` |
| 148 | Control_Status_Apttus | 1 | 306 | 4 | `s_m_Check_App_Control_Status_Apttus` |
| 149 | Asl_ORACLE_FED | 1 | 307 | 4 | `s_m_Check_App_Control_Status_Asl_ORACLE_FED` |
| 150 | Control_Status_BART | 1 | 308 | 4 | `s_m_Check_App_Control_Status_BART` |
| 151 | Control_Status_BASECAMP | 1 | 309 | 4 | `s_m_Check_App_Control_Status_BASECAMP` |
| 152 | Status_BA_HIST | 1 | 310 | 4 | `s_m_Check_App_Control_Status_BA_HIST` |
| 153 | Control_Status_BCV | 1 | 311 | 4 | `s_m_Check_App_Control_Status_BCV` |
| 154 | BILLVIZ_BILLING_ACCOUNT | 1 | 312 | 4 | `s_m_Check_App_Control_Status_BILLVIZ_BILLING_ACCOUNT` |
| 155 | Control_Status_BPMS | 1 | 313 | 4 | `s_m_Check_App_Control_Status_BPMS` |
| 156 | Control_Status_BRM | 1 | 314 | 4 | `s_m_Check_App_Control_Status_BRM` |
| 157 | Billing_Usage_Main | 1 | 315 | 4 | `s_m_Check_App_Control_Status_Billing_Usage_Main` |
| 158 | Control_Status_CDC | 1 | 318 | 4 | `s_m_Check_App_Control_Status_CDC` |
| 159 | ASL_CA2PD_USECASE5 | 1 | 320 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_CA2PD_USECASE5` |
| 160 | CABS_DATALAKE_REFRESH | 1 | 321 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_CABS_DATALAKE_REFRESH` |
| 161 | CNUM_CTS_USECASE3 | 1 | 322 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_CNUM_CTS_USECASE3` |
| 162 | CNUM_NAT_USECASE3 | 1 | 323 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_CNUM_NAT_USECASE3` |
| 163 | CORE_ORD_CONTACTS | 1 | 324 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_CORE_ORD_CONTACTS` |
| 164 | EIS_PORTAL_ORDER | 1 | 326 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_EIS_PORTAL_ORDER` |
| 165 | ASL_EIS_USECASE3 | 1 | 327 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_EIS_USECASE3` |
| 166 | ASL_EPWF_USECASE3 | 1 | 336 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_EPWF_USECASE3` |
| 167 | ASL_LIMS_USECASE3 | 1 | 337 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_LIMS_USECASE3` |
| 168 | PROD_ASSET_USECASE3 | 1 | 338 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_PROD_ASSET_USECASE3` |
| 169 | ASL_SDP_USECASE1 | 1 | 339 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_SDP_USECASE1` |
| 170 | ASL_SDP_USECASE3 | 1 | 340 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_SDP_USECASE3` |
| 171 | ASL_SDWF_USECASE9 | 1 | 342 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_SDWF_USECASE9` |
| 172 | CDL_ASL_SYSDATE | 1 | 343 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_SYSDATE` |
| 173 | WDM_ORDR_LFCYCL | 1 | 344 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_WDM_ORDR_LFCYCL` |
| 174 | ASL_WDM_USECASE5 | 1 | 345 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_WDM_USECASE5` |
| 175 | CDL_F2C_SFDC | 1 | 346 | 4 | `s_m_Check_App_Control_Status_CDL_F2C_SFDC` |
| 176 | Status_CDL_SFDC | 1 | 347 | 4 | `s_m_Check_App_Control_Status_CDL_SFDC` |
| 177 | Status_CDMT_SALESCOMP | 1 | 348 | 4 | `s_m_Check_App_Control_Status_CDMT_SALESCOMP` |
| 178 | CDW_ASL_CABS | 1 | 349 | 4 | `s_m_Check_App_Control_Status_CDW_ASL_CABS` |
| 179 | ASL_CABS_JDE | 1 | 350 | 4 | `s_m_Check_App_Control_Status_CDW_ASL_CABS_JDE` |
| 180 | CDW_ASL_ENS | 1 | 352 | 4 | `s_m_Check_App_Control_Status_CDW_ASL_ENS` |
| 181 | CDW_ASL_WDM | 1 | 353 | 4 | `s_m_Check_App_Control_Status_CDW_ASL_WDM` |
| 182 | Status_CDW_COMMON | 1 | 354 | 4 | `s_m_Check_App_Control_Status_CDW_COMMON` |
| 183 | Control_Status_CI | 1 | 355 | 4 | `s_m_Check_App_Control_Status_CI` |
| 184 | Status_CIRCUIT_ALL | 1 | 356 | 4 | `s_m_Check_App_Control_Status_CIRCUIT_ALL` |
| 185 | Status_CI_Done | 1 | 357 | 4 | `s_m_Check_App_Control_Status_CI_Done` |
| 186 | Status_CI_Orders | 1 | 358 | 4 | `s_m_Check_App_Control_Status_CI_Orders` |
| 187 | Status_CI_Orders1 | 1 | 359 | 4 | `s_m_Check_App_Control_Status_CI_Orders1` |
| 188 | Status_CI_TP | 1 | 360 | 4 | `s_m_Check_App_Control_Status_CI_TP` |
| 189 | CODS_BILLING_Refresh | 1 | 362 | 4 | `s_m_Check_App_Control_Status_CODS_BILLING_Refresh` |
| 190 | GL_SEG3_LOB | 1 | 365 | 4 | `s_m_Check_App_Control_Status_CODS_FINANCE_GL_SEG3_LOB` |
| 191 | Status_CODS_NETINV | 1 | 366 | 4 | `s_m_Check_App_Control_Status_CODS_NETINV` |
| 192 | Status_CODS_PCP | 1 | 367 | 4 | `s_m_Check_App_Control_Status_CODS_PCP` |
| 193 | Status_COMPLT_TIME | 1 | 368 | 4 | `s_m_Check_App_Control_Status_COMPLT_TIME` |
| 194 | Control_Status_CONTACT | 1 | 369 | 4 | `s_m_Check_App_Control_Status_CONTACT` |
| 195 | Control_Status_CRIS | 1 | 370 | 4 | `s_m_Check_App_Control_Status_CRIS` |
| 196 | CURR_EXCHANGE_RT | 1 | 372 | 4 | `s_m_Check_App_Control_Status_CURR_EXCHANGE_RT` |
| 197 | Control_Status_Change | 1 | 373 | 4 | `s_m_Check_App_Control_Status_Change` |
| 198 | Status_Change_1 | 1 | 374 | 4 | `s_m_Check_App_Control_Status_Change_1` |
| 199 | Control_Status_Check | 1 | 375 | 4 | `s_m_Check_App_Control_Status_Check` |
| 200 | DSL_FIN_Job | 1 | 376 | 4 | `s_m_Check_App_Control_Status_Check_DSL_FIN_Job` |
| 201 | Status_Clarify_SA | 1 | 377 | 4 | `s_m_Check_App_Control_Status_Clarify_SA` |
| 202 | Clarify_SA_CCL | 1 | 378 | 4 | `s_m_Check_App_Control_Status_Clarify_SA_CCL` |
| 203 | Clarify_sa_hrly | 1 | 379 | 4 | `s_m_Check_App_Control_Status_Clarify_sa_hrly` |
| 204 | Control_Status_Customer | 1 | 381 | 4 | `s_m_Check_App_Control_Status_Customer` |
| 205 | Control_Status_DSL | 1 | 400 | 4 | `s_m_Check_App_Control_Status_DSL` |
| 206 | AIM_ACE_MASTER | 1 | 402 | 4 | `s_m_Check_App_Control_Status_DSL_AIM_ACE_MASTER` |
| 207 | Status_DSL_ENS | 1 | 403 | 4 | `s_m_Check_App_Control_Status_DSL_ENS` |
| 208 | DSL_FINANCE_Refresh | 1 | 405 | 4 | `s_m_Check_App_Control_Status_DSL_FINANCE_Refresh` |
| 209 | Status_DSL_ORDER | 1 | 406 | 4 | `s_m_Check_App_Control_Status_DSL_ORDER` |
| 210 | DSL_ORDER_ENS | 1 | 407 | 4 | `s_m_Check_App_Control_Status_DSL_ORDER_ENS` |
| 211 | Status_DSP_STG | 1 | 408 | 4 | `s_m_Check_App_Control_Status_DSP_STG` |
| 212 | Status_EASE_CABS | 1 | 413 | 4 | `s_m_Check_App_Control_Status_EASE_CABS` |
| 213 | Control_Status_ECO | 1 | 418 | 4 | `s_m_Check_App_Control_Status_ECO` |
| 214 | ORDER_UPD_ICSM | 1 | 419 | 4 | `s_m_Check_App_Control_Status_EIS_ORDER_UPD_ICSM` |
| 215 | Control_Status_ENS | 1 | 420 | 4 | `s_m_Check_App_Control_Status_ENS` |
| 216 | EQUIPMENT_ALL_NCD | 1 | 421 | 5 | `s_m_Check_App_Control_Status_EQUIPMENT_ALL_NCD` |
| 217 | EQUIPMENT_ALL_OPSDB | 1 | 422 | 5 | `s_m_Check_App_Control_Status_EQUIPMENT_ALL_OPSDB` |
| 218 | Control_Status_ERM | 1 | 423 | 4 | `s_m_Check_App_Control_Status_ERM` |
| 219 | Status_ERM_SM | 1 | 424 | 4 | `s_m_Check_App_Control_Status_ERM_SM` |
| 220 | Status_GAAP_Refresh | 1 | 428 | 4 | `s_m_Check_App_Control_Status_GAAP_Refresh` |
| 221 | SEG2_PROFIT_CTR | 1 | 429 | 4 | `s_m_Check_App_Control_Status_GL_SEG2_PROFIT_CTR` |
| 222 | Control_Status_IDC | 1 | 430 | 4 | `s_m_Check_App_Control_Status_IDC` |
| 223 | Control_Status_ISRUNNING | 1 | 431 | 4 | `s_m_Check_App_Control_Status_ISRUNNING` |
| 224 | Control_Status_KENAN | 1 | 432 | 4 | `s_m_Check_App_Control_Status_KENAN` |
| 225 | Control_Status_KENANFX | 1 | 433 | 4 | `s_m_Check_App_Control_Status_KENANFX` |
| 226 | LEAD_TO_ORDER | 1 | 434 | 4 | `s_m_Check_App_Control_Status_LEAD_TO_ORDER` |
| 227 | LEGACY_CTL_BASECAMP | 1 | 435 | 4 | `s_m_Check_App_Control_Status_LEGACY_CTL_BASECAMP` |
| 228 | LEXM_BILLING_ACCOUNT | 1 | 436 | 4 | `s_m_Check_App_Control_Status_LEXM_BILLING_ACCOUNT` |
| 229 | LOCATION_ALL_PRO | 1 | 439 | 5 | `s_m_Check_App_Control_Status_LOCATION_ALL_PRO` |
| 230 | LOCATION_TIRKS_BUILDING | 1 | 441 | 5 | `s_m_Check_App_Control_Status_LOCATION_TIRKS_BUILDING` |
| 231 | Control_Status_MSSQL | 1 | 444 | 5 | `s_m_Check_App_Control_Status_MSSQL` |
| 232 | Control_Status_NETINV | 1 | 447 | 5 | `s_m_Check_App_Control_Status_NETINV` |
| 233 | Status_NETINV_LEGACY1 | 1 | 448 | 5 | `s_m_Check_App_Control_Status_NETINV_LEGACY1` |
| 234 | TRAIL_COMPONENT_ALL | 1 | 449 | 5 | `s_m_Check_App_Control_Status_NETINV_LEGACY_TRAIL_COMPONENT_ALL` |
| 235 | TRAIL_COMPONENT_ALL | 1 | 450 | 5 | `s_m_Check_App_Control_Status_NETINV_TRAIL_COMPONENT_ALL` |
| 236 | NETWORK_ELEMENT_TIRKS | 1 | 451 | 4 | `s_m_Check_App_Control_Status_NETWORK_ELEMENT_TIRKS` |
| 237 | Control_Status_NIBS | 1 | 452 | 4 | `s_m_Check_App_Control_Status_NIBS` |
| 238 | NRL_ORMT_SPED | 1 | 453 | 4 | `s_m_Check_App_Control_Status_NRL_ORMT_SPED` |
| 239 | Control_Status_NS | 1 | 454 | 4 | `s_m_Check_App_Control_Status_NS` |
| 240 | Netinv_Circuit_All | 1 | 455 | 4 | `s_m_Check_App_Control_Status_Netinv_Circuit_All` |
| 241 | Status_Netinv_Legacy | 1 | 456 | 4 | `s_m_Check_App_Control_Status_Netinv_Legacy` |
| 242 | ODS_ASSET_VIEW | 1 | 457 | 4 | `s_m_Check_App_Control_Status_ODS_ASSET_VIEW` |
| 243 | CPO_ORDER_RELATIONSHIP | 1 | 458 | 4 | `s_m_Check_App_Control_Status_ODS_CPO_ORDER_RELATIONSHIP` |
| 244 | Status_ODS_ENS1 | 1 | 459 | 5 | `s_m_Check_App_Control_Status_ODS_ENS1` |
| 245 | ODS_ORDER_COP | 1 | 461 | 4 | `s_m_Check_App_Control_Status_ODS_ORDER_COP` |
| 246 | Status_ODS_RSOR | 1 | 463 | 4 | `s_m_Check_App_Control_Status_ODS_RSOR` |
| 247 | SDP_ORDER_RELATIONSHIP | 1 | 464 | 4 | `s_m_Check_App_Control_Status_ODS_SDP_ORDER_RELATIONSHIP` |
| 248 | Customer_Only_4HR | 1 | 466 | 4 | `s_m_Check_App_Control_Status_ODS_SSQ_Customer_Only_4HR` |
| 249 | SWIFT_ORDER_RELATIONSHIP | 1 | 467 | 4 | `s_m_Check_App_Control_Status_ODS_SWIFT_ORDER_RELATIONSHIP` |
| 250 | Status_ODS_TN | 1 | 468 | 5 | `s_m_Check_App_Control_Status_ODS_TN` |
| 251 | Status_OFFNET_MATCH | 1 | 471 | 4 | `s_m_Check_App_Control_Status_OFFNET_MATCH` |
| 252 | Status_OFFNET_SEARCH | 1 | 472 | 5 | `s_m_Check_App_Control_Status_OFFNET_SEARCH` |
| 253 | Control_Status_ORA | 1 | 473 | 5 | `s_m_Check_App_Control_Status_ORA` |
| 254 | ORACLE_BILLING_ACCOUNT | 1 | 474 | 4 | `s_m_Check_App_Control_Status_ORACLE_BILLING_ACCOUNT` |
| 255 | Control_Status_PARALLELS | 1 | 476 | 4 | `s_m_Check_App_Control_Status_PARALLELS` |
| 256 | DEPENDENCY_CHECK_TIRKS | 1 | 477 | 5 | `s_m_Check_App_Control_Status_PHYSICAL_LOGICAL_DEPENDENCY_CHECK_TIRKS` |
| 257 | Status_Recon_Report | 1 | 479 | 4 | `s_m_Check_App_Control_Status_Recon_Report` |
| 258 | Control_Status_Refresh | 1 | 481 | 4 | `s_m_Check_App_Control_Status_Refresh` |
| 259 | Control_Status_SB | 1 | 492 | 4 | `s_m_Check_App_Control_Status_SB` |
| 260 | Control_Status_SESSSTARTTIME | 1 | 493 | 4 | `s_m_Check_App_Control_Status_SESSSTARTTIME` |
| 261 | Status_SESSSTARTTIME_HR | 1 | 494 | 4 | `s_m_Check_App_Control_Status_SESSSTARTTIME_HR` |
| 262 | Status_SFDC_OPPORTUNITY | 1 | 496 | 4 | `s_m_Check_App_Control_Status_SFDC_OPPORTUNITY` |
| 263 | OPPORTUNITY_SECOND_RN | 1 | 497 | 4 | `s_m_Check_App_Control_Status_SFDC_OPPORTUNITY_SECOND_RN` |
| 264 | Status_SFDC_USER | 1 | 498 | 4 | `s_m_Check_App_Control_Status_SFDC_USER` |
| 265 | Control_Status_SIEBEL | 1 | 499 | 4 | `s_m_Check_App_Control_Status_SIEBEL` |
| 266 | LATAM_BILLING_ACCOUNT | 1 | 500 | 4 | `s_m_Check_App_Control_Status_SIEBEL6_LATAM_BILLING_ACCOUNT` |
| 267 | LATAM_BILLING_ACCOUNT | 1 | 501 | 4 | `s_m_Check_App_Control_Status_SIEBEL8_LATAM_BILLING_ACCOUNT` |
| 268 | Control_Status_SITE | 1 | 502 | 5 | `s_m_Check_App_Control_Status_SITE` |
| 269 | Control_Status_SSQ | 1 | 506 | 4 | `s_m_Check_App_Control_Status_SSQ` |
| 270 | Control_Status_STG | 1 | 509 | 4 | `s_m_Check_App_Control_Status_STG` |
| 271 | STG_EIS_DEPEND | 1 | 510 | 4 | `s_m_Check_App_Control_Status_STG_EIS_DEPEND` |
| 272 | STG_TO_HIST | 1 | 511 | 4 | `s_m_Check_App_Control_Status_STG_TO_HIST` |
| 273 | SUP1_DSL_ORDER | 1 | 512 | 4 | `s_m_Check_App_Control_Status_SUP1_DSL_ORDER` |
| 274 | Control_Status_SYSDATE | 1 | 514 | 4 | `s_m_Check_App_Control_Status_SYSDATE` |
| 275 | ASL_ENS_8HR | 1 | 515 | 4 | `s_m_Check_App_Control_Status_SYSDATE_ASL_ENS_8HR` |
| 276 | ODS_ENS_8HR | 1 | 516 | 4 | `s_m_Check_App_Control_Status_SYSDATE_ODS_ENS_8HR` |
| 277 | Billing_Account_Hist | 1 | 517 | 4 | `s_m_Check_App_Control_Status_Source_Billing_Account_Hist` |
| 278 | Status_Src_Basecamp | 1 | 518 | 4 | `s_m_Check_App_Control_Status_Src_Basecamp` |
| 279 | Status_TAXMART_Refresh | 1 | 520 | 4 | `s_m_Check_App_Control_Status_TAXMART_Refresh` |
| 280 | EQP_HIER_DLY | 1 | 521 | 4 | `s_m_Check_App_Control_Status_TIRKS_EQP_HIER_DLY` |
| 281 | TN_XREF_DEPEND | 1 | 522 | 4 | `s_m_Check_App_Control_Status_TN_XREF_DEPEND` |
| 282 | TRAIL_STAGE_TIRKS | 1 | 523 | 4 | `s_m_Check_App_Control_Status_TRAIL_STAGE_TIRKS` |
| 283 | Control_Status_TTEKMART | 1 | 524 | 4 | `s_m_Check_App_Control_Status_TTEKMART` |
| 284 | Status_UPDATE_TRAIL | 1 | 525 | 5 | `s_m_Check_App_Control_Status_UPDATE_TRAIL` |
| 285 | Status_W_Case | 1 | 526 | 4 | `s_m_Check_App_Control_Status_W_Case` |
| 286 | load_ods_order2 | 1 | 527 | 4 | `s_m_Check_App_Control_Status_dcn_load_ods_order2` |
| 287 | load_ods_update | 1 | 528 | 4 | `s_m_Check_App_Control_Status_dcn_load_ods_update` |
| 288 | Status_eml_SUCCESS | 1 | 529 | 4 | `s_m_Check_App_Control_Status_eml_SUCCESS` |
| 289 | f_service_build | 1 | 530 | 4 | `s_m_Check_App_Control_Status_f_service_build` |
| 290 | LOAD_ODS_ELEMENT | 1 | 531 | 4 | `s_m_Check_App_Control_Status_wklt_LOAD_ODS_ELEMENT` |
| 291 | ORDER_INCR_AMT | 1 | 532 | 4 | `s_m_Check_App_Control_Status_wklt_LOAD_ODS_ORDER_INCR_AMT` |
| 292 | DSL_MARGIN_DAILY | 1 | 533 | 4 | `s_m_Check_App_DSL_MARGIN_DAILY` |
| 293 | DSL_MARGIN_weekly | 1 | 534 | 4 | `s_m_Check_App_DSL_MARGIN_weekly` |
| 294 | TRAIL_COMPONENT_NETFLEX | 1 | 537 | 5 | `s_m_Check_App_TRAIL_COMPONENT_NETFLEX` |
| 295 | Webvfo_Control_Status | 1 | 538 | 4 | `s_m_Check_App_Webvfo_Control_Status` |
| 296 | REPORT_FOR_KENAN | 1 | 540 | 4 | `s_m_Check_Completion_of_wkf_LOAD_TR_REPORT_FOR_KENAN` |
| 297 | FOR_MANUAL_CREDIT | 1 | 541 | 4 | `s_m_Check_Completion_of_wkf_LOAD_TR_REPORT_FOR_MANUAL_CREDIT` |
| 298 | FOR_ORACLE_AR | 1 | 542 | 4 | `s_m_Check_Completion_of_wkf_LOAD_TR_REPORT_FOR_ORACLE_AR` |
| 299 | Status_ORDER_ATTACHMENT | 1 | 543 | 4 | `s_m_Check_Control_Status_ORDER_ATTACHMENT` |
| 300 | Load_File_Count | 1 | 545 | 4 | `s_m_Check_DTE_Data_Load_File_Count` |
| 301 | Load_File_Count | 1 | 549 | 4 | `s_m_Check_LSP_Data_Load_File_Count` |
| 302 | of_BCV_BLFXRPT1 | 1 | 553 | 4 | `s_m_Check_Readiness_of_BCV_BLFXRPT1` |
| 303 | Readiness_of_CODS | 1 | 554 | 4 | `s_m_Check_Readiness_of_CODS` |
| 304 | Readiness_of_NRL | 1 | 557 | 4 | `s_m_Check_Readiness_of_NRL` |
| 305 | of_SSL_ORAFG | 1 | 558 | 4 | `s_m_Check_Readiness_of_SSL_ORAFG` |
| 306 | GL_MASTER_XREF | 1 | 588 | 5 | `s_m_Create_Indexes_DL_LEGACY_GL_MASTER_XREF` |
| 307 | XREF_NEXT_MNTH | 1 | 589 | 5 | `s_m_Create_Indexes_DL_LEGACY_GL_MASTER_XREF_NEXT_MNTH` |
| 308 | Delete_Duplicate_Records | 1 | 596 | 4 | `s_m_Delete_Duplicate_Records` |
| 309 | Records_In_FED | 1 | 597 | 4 | `s_m_Delete_Duplicate_Records_In_FED` |
| 310 | Records_In_FRD | 1 | 598 | 4 | `s_m_Delete_Duplicate_Records_In_FRD` |
| 311 | In_FRD_Cabs | 1 | 599 | 4 | `s_m_Delete_Duplicate_Records_In_FRD_Cabs` |
| 312 | In_FRD_Kenan | 1 | 600 | 4 | `s_m_Delete_Duplicate_Records_In_FRD_Kenan` |
| 313 | In_FRD_NIBS | 1 | 601 | 4 | `s_m_Delete_Duplicate_Records_In_FRD_NIBS` |
| 314 | GL_MASTER_XREF | 1 | 606 | 5 | `s_m_Drop_Indexes_Trunc_DL_LEGACY_GL_MASTER_XREF` |
| 315 | XREF_NEXT_MNTH | 1 | 607 | 5 | `s_m_Drop_Indexes_Trunc_DL_LEGACY_GL_MASTER_XREF_NEXT_MNTH` |
| 316 | TO_L_DRIVE | 1 | 609 | 2 | `s_m_Dummy_SEND_CAPEX_EXTRACT_SAP_BRIGHTSPEED_TO_L_DRIVE` |
| 317 | TO_L_DRIVE | 1 | 610 | 2 | `s_m_Dummy_SEND_CAPEX_EXTRACT_SAP_TO_L_DRIVE` |
| 318 | Update_SQL_Transformation | 1 | 2064 | 2 | `s_m_Load_DH_BILL_ACCOUNT_Update_SQL_Transformation` |
| 319 | MNTH_END_TRUNCATE | 1 | 3018 | 3 | `s_m_Load_GL_BALANCE_AMT_MNTH_END_TRUNCATE` |
| 320 | AMT_DAILY_TRUNCATE | 1 | 3211 | 3 | `s_m_Load_JOURNAL_LINE_AMT_DAILY_TRUNCATE` |
| 321 | AP_CHECK_TRUNCATE | 1 | 5283 | 3 | `s_m_Load_STG_AP_CHECK_TRUNCATE` |
| 322 | LINE_DIST_TRUNCATE | 1 | 5284 | 3 | `s_m_Load_STG_AP_TRXN_LINE_DIST_TRUNCATE` |
| 323 | TRXN_LINE_TRUNCATE | 1 | 5285 | 3 | `s_m_Load_STG_AP_TRXN_LINE_TRUNCATE` |
| 324 | AP_TRXN_TRUNCATE | 1 | 5286 | 3 | `s_m_Load_STG_AP_TRXN_TRUNCATE` |
| 325 | DETAIL_JL_TRUNC | 1 | 5287 | 3 | `s_m_Load_STG_AR_ACCRUAL_DETAIL_JL_TRUNC` |
| 326 | DIST_JL_TRUNCATE | 1 | 5288 | 3 | `s_m_Load_STG_AR_TRXN_LINE_DIST_JL_TRUNCATE` |
| 327 | REVENUE_DETAIL_TRUNC | 1 | 5305 | 2 | `s_m_Load_STG_F_REVENUE_DETAIL_TRUNC` |
| 328 | BALANCE_AMT_TRUNCATE | 1 | 5306 | 3 | `s_m_Load_STG_GL_BALANCE_AMT_TRUNCATE` |
| 329 | GL_BALANCE_TRUNCATE | 1 | 5307 | 3 | `s_m_Load_STG_GL_BALANCE_TRUNCATE` |
| 330 | JOURNAL_HEADER_TRUNCATE | 1 | 5308 | 3 | `s_m_Load_STG_JOURNAL_HEADER_TRUNCATE` |
| 331 | SL_DIST_TRUNC | 1 | 5309 | 3 | `s_m_Load_STG_JOURNAL_LINE_SL_DIST_TRUNC` |
| 332 | JOURNAL_LINE_TRUNCATE | 1 | 5310 | 3 | `s_m_Load_STG_JOURNAL_LINE_TRUNCATE` |
| 333 | PO_LINE_TRUNCATE | 1 | 5312 | 3 | `s_m_Load_STG_PO_LINE_TRUNCATE` |
| 334 | PURCHASE_ORDER_TRUNCATE | 1 | 5313 | 3 | `s_m_Load_STG_PURCHASE_ORDER_TRUNCATE` |
| 335 | PO_LINE_ALL | 1 | 5398 | 6 | `s_m_Load_SWAP_F_PO_LINE_ALL` |
| 336 | QTY_CURR_MNTH | 1 | 5414 | 7 | `s_m_Load_SWP_BILL_ACCT_PROCESS_QTY_CURR_MNTH` |
| 337 | QTY_PREV_MNTH | 1 | 5415 | 7 | `s_m_Load_SWP_BILL_ACCT_PROCESS_QTY_PREV_MNTH` |
| 338 | GL_SEGMENT_ALL | 1 | 5417 | 5 | `s_m_Load_SWP_D_GL_SEGMENT_ALL` |
| 339 | ALLOC_CURR_MNTH | 1 | 5425 | 6 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_CURR_MNTH` |
| 340 | ALLOC_NEXT_MNTH | 1 | 5426 | 6 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_NEXT_MNTH` |
| 341 | HC_CURR_MNTH | 1 | 5427 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_OVERLAY_HC_CURR_MNTH` |
| 342 | HC_NEXT_MNTH | 1 | 5428 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_OVERLAY_HC_NEXT_MNTH` |
| 343 | REVENUE_CURR_MNTH | 1 | 5429 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_OVERLAY_REVENUE_CURR_MNTH` |
| 344 | REVENUE_NEXT_MNTH | 1 | 5430 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_OVERLAY_REVENUE_NEXT_MNTH` |
| 345 | PARTITION_CURR_MNTH | 1 | 5431 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_SWAP_PARTITION_CURR_MNTH` |
| 346 | PARTITION_NEXT_MNTH | 1 | 5432 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_SWAP_PARTITION_NEXT_MNTH` |
| 347 | TRUNC_CURR_MNTH | 1 | 5433 | 2 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_TRUNC_CURR_MNTH` |
| 348 | TRUNC_NEXT_MNTH | 1 | 5434 | 2 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_TRUNC_NEXT_MNTH` |
| 349 | HC_CURR_MNTH | 1 | 5435 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_PRE_ALLOC_HC_CURR_MNTH` |
| 350 | HC_NEXT_MNTH | 1 | 5436 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_PRE_ALLOC_HC_NEXT_MNTH` |
| 351 | TRUNC_CURR_MNTH | 1 | 5437 | 2 | `s_m_Load_SWP_F_BALANCE_EXTRACT_PRE_ALLOC_TRUNC_CURR_MNTH` |
| 352 | TRUNC_NEXT_MNTH | 1 | 5438 | 2 | `s_m_Load_SWP_F_BALANCE_EXTRACT_PRE_ALLOC_TRUNC_NEXT_MNTH` |
| 353 | F_CAPEX_EXTRACT | 1 | 5445 | 6 | `s_m_Load_SWP_F_CAPEX_EXTRACT` |
| 354 | MISR_MONTHLY_SUM | 1 | 5480 | 8 | `s_m_Load_SWP_F_MISR_MONTHLY_SUM` |
| 355 | SUM_GROUP1_INS | 1 | 5481 | 4 | `s_m_Load_SWP_F_MISR_MONTHLY_SUM_GROUP1_INS` |
| 356 | SUM_GROUP2_INS | 1 | 5482 | 4 | `s_m_Load_SWP_F_MISR_MONTHLY_SUM_GROUP2_INS` |
| 357 | SUM_SWAP_PARTITIONS | 1 | 5483 | 4 | `s_m_Load_SWP_F_MISR_MONTHLY_SUM_SWAP_PARTITIONS` |
| 358 | MONTHLY_SUM_TRUNC | 1 | 5484 | 2 | `s_m_Load_SWP_F_MISR_MONTHLY_SUM_TRUNC` |
| 359 | DETAIL_NON_PAYABLES | 1 | 5485 | 4 | `s_m_Load_SWP_F_NETEX_DETAIL_NON_PAYABLES` |
| 360 | NETEX_DETAIL_PAYABLES | 1 | 5486 | 4 | `s_m_Load_SWP_F_NETEX_DETAIL_PAYABLES` |
| 361 | DETAIL_SWAP_PARTITIONS | 1 | 5493 | 4 | `s_m_Load_SWP_F_NETEX_DETAIL_SWAP_PARTITIONS` |
| 362 | NETEX_DETAIL_TRUNC | 1 | 5494 | 2 | `s_m_Load_SWP_F_NETEX_DETAIL_TRUNC` |
| 363 | LINE_DIST_ALL | 1 | 5495 | 6 | `s_m_Load_SWP_F_PA_EXP_LINE_DIST_ALL` |
| 364 | PA_PROJECT_ALL | 1 | 5496 | 6 | `s_m_Load_SWP_F_PA_PROJECT_ALL` |
| 365 | RECEIPT_TRXN_ALL | 1 | 5497 | 6 | `s_m_Load_SWP_F_PO_RECEIPT_TRXN_ALL` |
| 366 | REQN_LINE_ALL | 1 | 5498 | 6 | `s_m_Load_SWP_F_PO_REQN_LINE_ALL` |
| 367 | Set_Incremental_Mode | 1 | 5705 | 4 | `s_m_Load_Set_Incremental_Mode` |
| 368 | REBUILD_Task_Index | 1 | 6751 | 3 | `s_m_REBUILD_Task_Index` |
| 369 | BILLING_INVOICE_MVW | 1 | 6756 | 3 | `s_m_Refresh_BILLING_INVOICE_MVW` |
| 370 | UNUSABLE_Task_Index | 1 | 6849 | 4 | `s_m_UNUSABLE_Task_Index` |
| 371 | item_install_trail | 1 | 7067 | 4 | `s_m_check_app_control_edw_ods_ci_order_item_install_trail` |
| 372 | item_rearing_trail | 1 | 7068 | 4 | `s_m_check_app_control_edw_ods_ci_order_item_rearing_trail` |
| 373 | control_eon_equipment | 1 | 7069 | 4 | `s_m_check_app_control_eon_equipment` |
| 374 | control_eon_logical | 1 | 7070 | 4 | `s_m_check_app_control_eon_logical` |
| 375 | control_eon_phystruct | 1 | 7071 | 4 | `s_m_check_app_control_eon_phystruct` |
| 376 | ASL_AMDOCS_USM | 1 | 7072 | 4 | `s_m_check_app_control_status_ASL_AMDOCS_USM` |
| 377 | Customer_Attribution_Hist | 1 | 7073 | 4 | `s_m_check_app_control_status_Customer_Attribution_Hist` |
| 378 | asl_eon_sst1 | 1 | 7074 | 4 | `s_m_check_app_control_status_asl_eon_sst1` |
| 379 | asl_eon_stg | 1 | 7075 | 4 | `s_m_check_app_control_status_asl_eon_stg` |
| 380 | status_asl_naviscore | 1 | 7076 | 4 | `s_m_check_app_control_status_asl_naviscore` |
| 381 | incorrect_net_ttr | 1 | 7077 | 4 | `s_m_check_app_control_status_incorrect_net_ttr` |
| 382 | ATTRIB_REV_Index | 1 | 7177 | 8 | `s_m_create_CUST_ORDER_ATTRIB_REV_Index` |
| 383 | ATTRIB_REV_Index1 | 1 | 7178 | 8 | `s_m_create_CUST_ORDER_ATTRIB_REV_Index1` |
| 384 | ATTRIB_REV_Index | 1 | 7179 | 8 | `s_m_create_SWP_CUST_ORDER_ATTRIB_REV_Index` |
| 385 | ORDER_PRODUCT_Index | 1 | 7180 | 12 | `s_m_create_SWP_V_CUSTOMER_ORDER_PRODUCT_Index` |
| 386 | PRODUCT_COMPNT_Index | 1 | 7181 | 11 | `s_m_create_SWP_V_ORDER_PRODUCT_COMPNT_Index` |
| 387 | PRODUCT_COMPNT_Index | 1 | 7182 | 6 | `s_m_create_V_ORDER_PRODUCT_COMPNT_Index` |
| 388 | PRODUCT_COMPNT_Index1 | 1 | 7183 | 6 | `s_m_create_V_ORDER_PRODUCT_COMPNT_Index1` |
| 389 | REVENUE_TERM_FORECAST | 1 | 7184 | 4 | `s_m_create_backup_F_REVENUE_TERM_FORECAST` |
| 390 | ORDER_PRODUCT_Index | 1 | 7197 | 3 | `s_m_disable_SWP_V_CUSTOMER_ORDER_PRODUCT_Index` |
| 391 | PRODUCT_COMPNT_Index | 1 | 7198 | 3 | `s_m_disable_SWP_V_ORDER_PRODUCT_COMPNT_Index` |
| 392 | ATTRIB_REV_Index | 1 | 7199 | 8 | `s_m_drop_CUST_ORDER_ATTRIB_REV_Index` |
| 393 | ATTRIB_REV_Index1 | 1 | 7200 | 8 | `s_m_drop_CUST_ORDER_ATTRIB_REV_Index1` |
| 394 | ATTRIB_REV_Index | 1 | 7201 | 8 | `s_m_drop_SWP_CUST_ORDER_ATTRIB_REV_Index` |
| 395 | ORDER_PRODUCT_Index | 1 | 7202 | 12 | `s_m_drop_SWP_V_CUSTOMER_ORDER_PRODUCT_Index` |
| 396 | PRODUCT_COMPNT_Index | 1 | 7203 | 11 | `s_m_drop_SWP_V_ORDER_PRODUCT_COMPNT_Index` |
| 397 | PRODUCT_COMPNT_Index | 1 | 7204 | 6 | `s_m_drop_V_ORDER_PRODUCT_COMPNT_Index` |
| 398 | PRODUCT_COMPNT_Index1 | 1 | 7205 | 6 | `s_m_drop_V_ORDER_PRODUCT_COMPNT_Index1` |
| 399 | ORDER_PRODUCT_Index | 1 | 7222 | 3 | `s_m_enable_SWP_V_CUSTOMER_ORDER_PRODUCT_Index` |
| 400 | PRODUCT_COMPNT_Index | 1 | 7223 | 3 | `s_m_enable_SWP_V_ORDER_PRODUCT_COMPNT_Index` |
| 401 | CUSTOMER_ORDER_PRODUCT | 1 | 7615 | 3 | `s_m_trunc_SWP_V_CUSTOMER_ORDER_PRODUCT` |
| 402 | ORDER_PRODUCT_COMPNT | 1 | 7616 | 3 | `s_m_trunc_SWP_V_ORDER_PRODUCT_COMPNT` |
| 403 | ORDER_PRODUCT_COMPNT | 1 | 7617 | 3 | `s_m_trunc_V_ORDER_PRODUCT_COMPNT` |

#### DG_2 — 146 members
- **Sources:** `DIVESTITURE_DAILY_TABLE_CNT`
- **Targets:** `CDW_COMMON, DIVESTITURE_DAILY_TABLE_CNT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Validations_ASL_BLUEMARBLE | 1 | 2159 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_BLUEMARBLE` |
| 2 | Validations_ASL_CABS | 1 | 2160 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_CABS` |
| 3 | Validations_ASL_GAM | 1 | 2167 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_GAM` |
| 4 | ASL_SALESFORCE_CTL | 1 | 2174 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_SALESFORCE_CTL` |
| 5 | CCDW_CTLQWEST_1 | 1 | 2187 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_CTLQWEST_1` |
| 6 | CCDW_CTLQWEST_2 | 1 | 2188 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_CTLQWEST_2` |
| 7 | CCDW_CTLQWEST_3 | 1 | 2189 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_CTLQWEST_3` |
| 8 | Validations_CCDW_DWBIREF | 1 | 2190 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_DWBIREF` |
| 9 | Validations_CCDW_DWDPTORA | 1 | 2192 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_DWDPTORA` |
| 10 | Validations_CCDW_ENTP | 1 | 2193 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_ENTP` |
| 11 | Validations_CCDW_STAGE | 1 | 2196 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_STAGE` |
| 12 | Validations_CCDW_STRVISO | 1 | 2197 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_STRVISO` |
| 13 | FINANCE_GL_COMP | 1 | 2203 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_FINANCE_GL_COMP` |
| 14 | CDW_DSL_CONSUMER | 1 | 2220 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_CONSUMER` |
| 15 | CDW_DSL_FINANCE | 1 | 2222 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_FINANCE` |
| 16 | DSL_FINANCE_1 | 1 | 2223 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_FINANCE_1` |
| 17 | DSL_FINANCE_2 | 1 | 2224 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_FINANCE_2` |
| 18 | DSL_FINANCE_3 | 1 | 2225 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_FINANCE_3` |
| 19 | FINANCE_GL_COMP | 1 | 2226 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_FINANCE_GL_COMP` |
| 20 | Validations_DSLIDR_NIDRSINV | 1 | 2242 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DSLIDR_NIDRSINV` |
| 21 | Validations_DSLIDR_NIDRVWS | 1 | 2243 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DSLIDR_NIDRVWS` |
| 22 | Validations_DWBRT_AGGR | 1 | 2244 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_AGGR` |
| 23 | Validations_DWBRT_BLUEMARBLE | 1 | 2245 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_BLUEMARBLE` |
| 24 | DWBRT_CCDW_DWBIREF | 1 | 2246 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CCDW_DWBIREF` |
| 25 | DWBRT_CCDW_DWDPTORA | 1 | 2247 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CCDW_DWDPTORA` |
| 26 | DWBRT_CCDW_SAL2BILL | 1 | 2248 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CCDW_SAL2BILL` |
| 27 | Validations_DWBRT_CIARPT | 1 | 2249 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CIARPT` |
| 28 | CLARIFY_AUTO_NOTIFY | 1 | 2250 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CLARIFY_AUTO_NOTIFY` |
| 29 | DWBRT_CLARIFY_SA | 1 | 2251 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CLARIFY_SA` |
| 30 | Validations_DWBRT_CODS | 1 | 2252 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CODS` |
| 31 | DWBRT_CODS_FINANCE | 1 | 2253 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CODS_FINANCE` |
| 32 | DWBRT_CODS_NETEX | 1 | 2254 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CODS_NETEX` |
| 33 | DWBRT_CODS_NETINV | 1 | 2255 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CODS_NETINV` |
| 34 | DWBRT_CODS_OFFNET | 1 | 2256 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CODS_OFFNET` |
| 35 | DWBRT_CODS_SERVICE | 1 | 2257 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CODS_SERVICE` |
| 36 | DWBRT_CODS_TN | 1 | 2258 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CODS_TN` |
| 37 | DWBRT_CRPL_GCR | 1 | 2259 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CRPL_GCR` |
| 38 | CRPL_SALESFORCE_CTL | 1 | 2260 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CRPL_SALESFORCE_CTL` |
| 39 | DWBRT_CTLQWEST_1 | 1 | 2261 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CTLQWEST_1` |
| 40 | DWBRT_CTLQWEST_2 | 1 | 2262 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CTLQWEST_2` |
| 41 | DWBRT_CTLQWEST_3 | 1 | 2263 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CTLQWEST_3` |
| 42 | Validations_DWBRT_CUREFSS1 | 1 | 2264 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_CUREFSS1` |
| 43 | DB_LINK_OUT | 1 | 2265 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DB_LINK_OUT` |
| 44 | Validations_DWBRT_DIM1 | 1 | 2266 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DIM1` |
| 45 | Validations_DWBRT_DIM2 | 1 | 2267 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DIM2` |
| 46 | Validations_DWBRT_DREGLTRY | 1 | 2268 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DREGLTRY` |
| 47 | DWBRT_DSL_AML | 1 | 2269 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DSL_AML` |
| 48 | DWBRT_DSL_CONSUMER | 1 | 2270 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DSL_CONSUMER` |
| 49 | DWBRT_DSL_DATAMKTP | 1 | 2271 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DSL_DATAMKTP` |
| 50 | DWBRT_DSL_FINANCE | 1 | 2272 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DSL_FINANCE` |
| 51 | DWBRT_DSL_ORDER | 1 | 2273 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DSL_ORDER` |
| 52 | DSL_SALES_PERIOD | 1 | 2274 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DSL_SALES_PERIOD` |
| 53 | DWBRT_DSL_SCM | 1 | 2275 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DSL_SCM` |
| 54 | DWBRT_DSL_SD | 1 | 2276 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DSL_SD` |
| 55 | DWBRT_DSL_SM | 1 | 2277 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DSL_SM` |
| 56 | Validations_DWBRT_DWBIREF | 1 | 2278 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DWBIREF` |
| 57 | DWBRT_DWBI_ETL | 1 | 2279 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DWBI_ETL` |
| 58 | Validations_DWBRT_DWODSORA | 1 | 2280 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DWODSORA` |
| 59 | DWBRT_DWOPS_DWDPTORA | 1 | 2281 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DWOPS_DWDPTORA` |
| 60 | Validations_DWBRT_DWREG1 | 1 | 2282 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_DWREG1` |
| 61 | Validations_DWBRT_ENS | 1 | 2283 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_ENS` |
| 62 | Validations_DWBRT_ENTP | 1 | 2284 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_ENTP` |
| 63 | Validations_DWBRT_IDRM | 1 | 2285 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_IDRM` |
| 64 | Validations_DWBRT_IRDM | 1 | 2286 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_IRDM` |
| 65 | Validations_DWBRT_LQSM | 1 | 2287 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_LQSM` |
| 66 | Validations_DWBRT_NIDRSINV | 1 | 2288 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_NIDRSINV` |
| 67 | Validations_DWBRT_NIDRVWS | 1 | 2289 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_NIDRVWS` |
| 68 | DWBRT_NRL_CASC | 1 | 2290 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_NRL_CASC` |
| 69 | Validations_DWBRT_NTWKRPT | 1 | 2291 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_NTWKRPT` |
| 70 | Validations_DWBRT_ODSUSR | 1 | 2292 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_ODSUSR` |
| 71 | Validations_DWBRT_PRGMR | 1 | 2293 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_PRGMR` |
| 72 | Validations_DWBRT_REF | 1 | 2294 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_REF` |
| 73 | Validations_DWBRT_RPT | 1 | 2295 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_RPT` |
| 74 | Validations_DWBRT_RRSV2 | 1 | 2296 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_RRSV2` |
| 75 | Validations_DWBRT_S2BETL | 1 | 2297 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_S2BETL` |
| 76 | DWBRT_SBMS_SB360 | 1 | 2298 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_SBMS_SB360` |
| 77 | Validations_DWBRT_SCLOAD | 1 | 2299 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_SCLOAD` |
| 78 | Validations_DWBRT_SCREPORT | 1 | 2300 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_SCREPORT` |
| 79 | Validations_DWBRT_SCRULES | 1 | 2301 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_SCRULES` |
| 80 | Validations_DWBRT_STAGED | 1 | 2302 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_STAGED` |
| 81 | DWBRT_STAGE_CCDW | 1 | 2303 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_STAGE_CCDW` |
| 82 | DWBRT_STAGE_DWBS | 1 | 2304 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_STAGE_DWBS` |
| 83 | DWBRT_STAGE_DWOPS | 1 | 2305 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_STAGE_DWOPS` |
| 84 | DWBRT_STAGE_DWPR | 1 | 2306 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_STAGE_DWPR` |
| 85 | DWBRT_STAGE_REFARCH | 1 | 2307 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_STAGE_REFARCH` |
| 86 | Validations_DWBRT_STRVISO | 1 | 2308 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_STRVISO` |
| 87 | Validations_DWBRT_USR | 1 | 2309 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_USR` |
| 88 | Validations_DWBRT_WFMIMP1 | 1 | 2310 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBRT_WFMIMP1` |
| 89 | Validations_DWBS_DWBIREF | 1 | 2311 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBS_DWBIREF` |
| 90 | Validations_DWBS_STAGE | 1 | 2312 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWBS_STAGE` |
| 91 | Validations_DWDN_DREGLTRY | 1 | 2313 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWDN_DREGLTRY` |
| 92 | Validations_DWDN_DWODSORA | 1 | 2314 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWDN_DWODSORA` |
| 93 | DWLAT_CCDW_SAL2BILL | 1 | 2316 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CCDW_SAL2BILL` |
| 94 | DWLAT_CLARIFY_SA | 1 | 2317 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CLARIFY_SA` |
| 95 | Validations_DWLAT_CODS | 1 | 2318 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CODS` |
| 96 | DWLAT_CODS_FINANCE | 1 | 2319 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CODS_FINANCE` |
| 97 | DWLAT_CODS_NETEX | 1 | 2320 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CODS_NETEX` |
| 98 | DWLAT_CODS_NETINV | 1 | 2321 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CODS_NETINV` |
| 99 | DWLAT_CODS_NOE | 1 | 2322 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CODS_NOE` |
| 100 | DWLAT_CODS_SCM | 1 | 2323 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CODS_SCM` |
| 101 | DWLAT_CODS_SERVICE | 1 | 2324 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CODS_SERVICE` |
| 102 | DWLAT_CRPL_GCR | 1 | 2325 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CRPL_GCR` |
| 103 | CRPL_SALESFORCE_CTL | 1 | 2326 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CRPL_SALESFORCE_CTL` |
| 104 | Validations_DWLAT_CTLQWEST | 1 | 2327 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_CTLQWEST` |
| 105 | DB_LINK_OUT | 1 | 2328 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DB_LINK_OUT` |
| 106 | DWLAT_DSL_AML | 1 | 2329 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DSL_AML` |
| 107 | DWLAT_DSL_FINANCE | 1 | 2330 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DSL_FINANCE` |
| 108 | DWLAT_DSL_MARGIN | 1 | 2331 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DSL_MARGIN` |
| 109 | DWLAT_DSL_ORDER | 1 | 2332 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DSL_ORDER` |
| 110 | DSL_SALES_PERIOD | 1 | 2333 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DSL_SALES_PERIOD` |
| 111 | DWLAT_DSL_SCM | 1 | 2334 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DSL_SCM` |
| 112 | DWLAT_DSL_SD | 1 | 2335 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DSL_SD` |
| 113 | DWLAT_DSL_SM | 1 | 2336 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DSL_SM` |
| 114 | Validations_DWLAT_DWBIREF | 1 | 2337 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DWBIREF` |
| 115 | DWLAT_DWBI_ETL | 1 | 2338 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DWBI_ETL` |
| 116 | DWLAT_DWDN_DREGLTRY | 1 | 2339 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_DWDN_DREGLTRY` |
| 117 | DWLAT_NRL_CASC | 1 | 2340 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_NRL_CASC` |
| 118 | Validations_DWLAT_S2BETL | 1 | 2341 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_S2BETL` |
| 119 | DWLAT_STAGE_CCDW | 1 | 2342 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_STAGE_CCDW` |
| 120 | DWLAT_STAGE_DWBS | 1 | 2343 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_STAGE_DWBS` |
| 121 | DWLAT_STAGE_DWOPS | 1 | 2344 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_STAGE_DWOPS` |
| 122 | Validations_DWLAT_WFMIMP1 | 1 | 2345 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWLAT_WFMIMP1` |
| 123 | Validations_DWOPS_CIARPT | 1 | 2415 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWOPS_CIARPT` |
| 124 | Validations_DWOPS_DWDPTORA | 1 | 2416 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWOPS_DWDPTORA` |
| 125 | Validations_DWOPS_STAGE | 1 | 2417 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWOPS_STAGE` |
| 126 | Validations_DWOPS_STAGED | 1 | 2418 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWOPS_STAGED` |
| 127 | Validations_DWPR_AGGR | 1 | 2419 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_AGGR` |
| 128 | Validations_DWPR_CUREFSS1 | 1 | 2420 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_CUREFSS1` |
| 129 | Validations_DWPR_DIM | 1 | 2421 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_DIM` |
| 130 | Validations_DWPR_DWREG1 | 1 | 2422 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_DWREG1` |
| 131 | Validations_DWPR_ENS | 1 | 2423 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_ENS` |
| 132 | Validations_DWPR_IDRM | 1 | 2424 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_IDRM` |
| 133 | Validations_DWPR_ODSUSR | 1 | 2425 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_ODSUSR` |
| 134 | Validations_DWPR_PRGMR | 1 | 2426 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_PRGMR` |
| 135 | Validations_DWPR_REF | 1 | 2427 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_REF` |
| 136 | Validations_DWPR_RPT | 1 | 2428 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_RPT` |
| 137 | Validations_DWPR_SCLOAD | 1 | 2429 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_SCLOAD` |
| 138 | Validations_DWPR_SCREPORT | 1 | 2430 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_SCREPORT` |
| 139 | Validations_DWPR_SCRULES | 1 | 2431 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_SCRULES` |
| 140 | Validations_DWPR_STAGE | 1 | 2432 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_STAGE` |
| 141 | DWPR_STAGE_REFARCH | 1 | 2433 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_STAGE_REFARCH` |
| 142 | Validations_DWPR_USR | 1 | 2434 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWPR_USR` |
| 143 | Validations_FRAM_LQSM | 1 | 2435 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_FRAM_LQSM` |
| 144 | Validations_FRAM_NTWKRPT | 1 | 2436 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_FRAM_NTWKRPT` |
| 145 | Validations_QGEM_RRSV2 | 1 | 2438 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_QGEM_RRSV2` |
| 146 | Validations_SBMS_SB360 | 1 | 2439 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_SBMS_SB360` |

#### DG_3 — 138 members
- **Sources:** `DIVESTITURE_DAILY_TABLE_CNT`
- **Targets:** `CDW_COMMON, DIVESTITURE_DAILY_TABLE_CNT, DIVESTITURE_DAILY_TBL_CNT_MRLN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASL_AMDOCS_RM | 1 | 2156 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_AMDOCS_RM` |
| 2 | ASL_AMDOCS_USM | 1 | 2157 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_AMDOCS_USM` |
| 3 | Validations_ASL_ASRC | 1 | 2158 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_ASRC` |
| 4 | Validations_ASL_CAT | 1 | 2161 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_CAT` |
| 5 | ASL_CLARIFY_AMOWNER | 1 | 2162 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_CLARIFY_AMOWNER` |
| 6 | CLARIFY_AUTO_NOTIFY | 1 | 2163 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_CLARIFY_AUTO_NOTIFY` |
| 7 | ASL_CLARIFY_SA | 1 | 2164 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_CLARIFY_SA` |
| 8 | Validations_ASL_CPO | 1 | 2165 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_CPO` |
| 9 | Validations_ASL_FIREWORKS | 1 | 2166 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_FIREWORKS` |
| 10 | Validations_ASL_GRANITE | 1 | 2168 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_GRANITE` |
| 11 | Validations_ASL_LMS | 1 | 2169 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_LMS` |
| 12 | Validations_ASL_METASTORM | 1 | 2170 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_METASTORM` |
| 13 | Validations_ASL_ORION | 1 | 2171 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_ORION` |
| 14 | Validations_ASL_PIPELINE | 1 | 2172 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_PIPELINE` |
| 15 | Validations_ASL_QMV | 1 | 2173 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_QMV` |
| 16 | SAM_SYNCH_EMEA | 1 | 2175 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_SAM_SYNCH_EMEA` |
| 17 | Validations_ASL_SAO | 1 | 2176 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_SAO` |
| 18 | Validations_ASL_SAP | 1 | 2177 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_SAP` |
| 19 | ASL_SAVVION_SBM | 1 | 2178 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_SAVVION_SBM` |
| 20 | ASL_SAVVION_WRKFL | 1 | 2179 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_SAVVION_WRKFL` |
| 21 | SSL_METRO_STG | 1 | 2180 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_SSL_METRO_STG` |
| 22 | Validations_ASL_SWIFT | 1 | 2181 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_SWIFT` |
| 23 | ASL_SWIFT_INV | 1 | 2182 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_SWIFT_INV` |
| 24 | ASL_THREED_NOE | 1 | 2183 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_THREED_NOE` |
| 25 | Validations_ASL_WM | 1 | 2184 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ASL_WM` |
| 26 | Validations_CCDW_BOSECPRD | 1 | 2185 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_BOSECPRD` |
| 27 | Validations_CCDW_CTLQWEST | 1 | 2186 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_CTLQWEST` |
| 28 | CCDW_DWBI_ETL | 1 | 2191 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_DWBI_ETL` |
| 29 | Validations_CCDW_S2BETL | 1 | 2194 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_S2BETL` |
| 30 | Validations_CCDW_SAL2BILL | 1 | 2195 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CCDW_SAL2BILL` |
| 31 | PM_COLT_UNITCOST | 1 | 2198 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_APP_PM_COLT_UNITCOST` |
| 32 | CDW_CDW_COMMON | 1 | 2199 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CDW_COMMON` |
| 33 | Validations_CDW_CODS | 1 | 2200 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS` |
| 34 | CDW_CODS_BILLING | 1 | 2201 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_BILLING` |
| 35 | CDW_CODS_FINANCE | 1 | 2202 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_FINANCE` |
| 36 | CDW_CODS_NETEX | 1 | 2204 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_NETEX` |
| 37 | CDW_CODS_NETINV | 1 | 2205 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_NETINV` |
| 38 | CDW_CODS_NOE | 1 | 2206 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_NOE` |
| 39 | CDW_CODS_OFFNET | 1 | 2207 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_OFFNET` |
| 40 | CDW_CODS_SCM | 1 | 2208 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_SCM` |
| 41 | CDW_CODS_SERVICE | 1 | 2209 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_SERVICE` |
| 42 | CDW_CODS_TN | 1 | 2210 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_TN` |
| 43 | CDW_CODS_WORKFLOW | 1 | 2211 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CODS_WORKFLOW` |
| 44 | CDW_CRPL_GCR | 1 | 2212 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CRPL_GCR` |
| 45 | CRPL_KENAN_IDC | 1 | 2213 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CRPL_KENAN_IDC` |
| 46 | CDW_CRPL_PRIME | 1 | 2214 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CRPL_PRIME` |
| 47 | CRPL_SALESFORCE_CTL | 1 | 2215 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CRPL_SALESFORCE_CTL` |
| 48 | CDW_CRPL_SWIFT | 1 | 2216 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_CRPL_SWIFT` |
| 49 | CDW_DSL_AIM | 1 | 2217 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_AIM` |
| 50 | CDW_DSL_AML | 1 | 2218 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_AML` |
| 51 | CDW_DSL_BILLING | 1 | 2219 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_BILLING` |
| 52 | CDW_DSL_DATAMKTP | 1 | 2221 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_DATAMKTP` |
| 53 | DSL_FINANCE_MERLIN | 1 | 2227 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_FINANCE_MERLIN` |
| 54 | CDW_DSL_MARGIN | 1 | 2228 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_MARGIN` |
| 55 | CDW_DSL_ORDER | 1 | 2229 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_ORDER` |
| 56 | DSL_SALES_PERIOD | 1 | 2230 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_SALES_PERIOD` |
| 57 | CDW_DSL_SCM | 1 | 2231 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_SCM` |
| 58 | CDW_DSL_SD | 1 | 2232 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_SD` |
| 59 | CDW_DSL_SM | 1 | 2233 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_DSL_SM` |
| 60 | Validations_CDW_FISCDM | 1 | 2234 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_FISCDM` |
| 61 | CDW_NRL_CASC | 1 | 2235 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_NRL_CASC` |
| 62 | Validations_CDW_SPEEDWARE | 1 | 2236 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_SPEEDWARE` |
| 63 | CDW_UDL_FI | 1 | 2237 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_UDL_FI` |
| 64 | CDW_UDL_OPSBI | 1 | 2238 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_UDL_OPSBI` |
| 65 | Validations_CDW_WFMIMP1 | 1 | 2239 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CDW_WFMIMP1` |
| 66 | CLARPROD_CLARIFY_SA | 1 | 2240 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CLARPROD_CLARIFY_SA` |
| 67 | DB_LINK_OUT | 1 | 2241 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_CLARPROD_DB_LINK_OUT` |
| 68 | Validations_DWDV1_IPDS | 1 | 2315 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWDV1_IPDS` |
| 69 | DWMLN_AMDOCS_RM | 1 | 2346 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_AMDOCS_RM` |
| 70 | DWMLN_AMDOCS_USM | 1 | 2347 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_AMDOCS_USM` |
| 71 | PM_COLT_UNITCOST | 1 | 2348 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_APP_PM_COLT_UNITCOST` |
| 72 | Validations_DWMLN_ASRC | 1 | 2349 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_ASRC` |
| 73 | Validations_DWMLN_BOSECPRD | 1 | 2350 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_BOSECPRD` |
| 74 | Validations_DWMLN_CAT | 1 | 2351 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CAT` |
| 75 | DWMLN_CDW_COMMON | 1 | 2352 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CDW_COMMON` |
| 76 | DWMLN_CLARIFY_AMOWNER | 1 | 2353 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CLARIFY_AMOWNER` |
| 77 | CLARIFY_AUTO_NOTIFY | 1 | 2354 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CLARIFY_AUTO_NOTIFY` |
| 78 | DWMLN_CLARIFY_SA | 1 | 2355 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CLARIFY_SA` |
| 79 | CLARPROD_CLARIFY_SA | 1 | 2356 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CLARPROD_CLARIFY_SA` |
| 80 | Validations_DWMLN_CODS | 1 | 2357 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS` |
| 81 | DWMLN_CODS_BILLING | 1 | 2358 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_BILLING` |
| 82 | DWMLN_CODS_FINANCE | 1 | 2359 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_FINANCE` |
| 83 | DWMLN_CODS_NETEX | 1 | 2360 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_NETEX` |
| 84 | DWMLN_CODS_NETINV | 1 | 2361 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_NETINV` |
| 85 | DWMLN_CODS_NOE | 1 | 2362 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_NOE` |
| 86 | DWMLN_CODS_OFFNET | 1 | 2363 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_OFFNET` |
| 87 | DWMLN_CODS_SCM | 1 | 2364 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_SCM` |
| 88 | DWMLN_CODS_SERVICE | 1 | 2365 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_SERVICE` |
| 89 | DWMLN_CODS_TN | 1 | 2366 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_TN` |
| 90 | DWMLN_CODS_WORKFLOW | 1 | 2367 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CODS_WORKFLOW` |
| 91 | Validations_DWMLN_CPO | 1 | 2368 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CPO` |
| 92 | DWMLN_CRPL_GCR | 1 | 2369 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CRPL_GCR` |
| 93 | CRPL_KENAN_IDC | 1 | 2370 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CRPL_KENAN_IDC` |
| 94 | DWMLN_CRPL_PRIME | 1 | 2371 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CRPL_PRIME` |
| 95 | CRPL_SALESFORCE_CTL | 1 | 2372 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CRPL_SALESFORCE_CTL` |
| 96 | DWMLN_CRPL_SWIFT | 1 | 2373 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CRPL_SWIFT` |
| 97 | Validations_DWMLN_CTLQWEST | 1 | 2374 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_CTLQWEST` |
| 98 | DB_LINK_OUT | 1 | 2375 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DB_LINK_OUT` |
| 99 | DWMLN_DSL_AIM | 1 | 2376 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_AIM` |
| 100 | DWMLN_DSL_AML | 1 | 2377 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_AML` |
| 101 | DWMLN_DSL_BILLING | 1 | 2378 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_BILLING` |
| 102 | DWMLN_DSL_DATAMKTP | 1 | 2379 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_DATAMKTP` |
| 103 | DWMLN_DSL_FINANCE | 1 | 2380 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_FINANCE` |
| 104 | DWMLN_DSL_MARGIN | 1 | 2381 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_MARGIN` |
| 105 | DWMLN_DSL_ORDER | 1 | 2382 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_ORDER` |
| 106 | DSL_SALES_PERIOD | 1 | 2383 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_SALES_PERIOD` |
| 107 | DWMLN_DSL_SCM | 1 | 2384 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_SCM` |
| 108 | DWMLN_DSL_SD | 1 | 2385 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_SD` |
| 109 | DWMLN_DSL_SM | 1 | 2386 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DSL_SM` |
| 110 | DWMLN_DWBI_ETL | 1 | 2387 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_DWBI_ETL` |
| 111 | Validations_DWMLN_FIREWORKS | 1 | 2388 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_FIREWORKS` |
| 112 | Validations_DWMLN_FISCDM | 1 | 2389 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_FISCDM` |
| 113 | Validations_DWMLN_GRANITE | 1 | 2390 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_GRANITE` |
| 114 | Validations_DWMLN_ICSM | 1 | 2391 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_ICSM` |
| 115 | Validations_DWMLN_IPDS | 1 | 2392 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_IPDS` |
| 116 | Validations_DWMLN_LMS | 1 | 2393 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_LMS` |
| 117 | Validations_DWMLN_METASTORM | 1 | 2394 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_METASTORM` |
| 118 | DWMLN_NRL_CASC | 1 | 2395 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_NRL_CASC` |
| 119 | Validations_DWMLN_ORION | 1 | 2396 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_ORION` |
| 120 | Validations_DWMLN_PIPELINE | 1 | 2397 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_PIPELINE` |
| 121 | Validations_DWMLN_QMV | 1 | 2398 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_QMV` |
| 122 | Validations_DWMLN_S2BETL | 1 | 2399 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_S2BETL` |
| 123 | Validations_DWMLN_SAL2BILL | 1 | 2400 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SAL2BILL` |
| 124 | SAM_SYNCH_EMEA | 1 | 2401 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SAM_SYNCH_EMEA` |
| 125 | Validations_DWMLN_SAO | 1 | 2402 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SAO` |
| 126 | Validations_DWMLN_SAP | 1 | 2403 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SAP` |
| 127 | DWMLN_SAVVION_SBM | 1 | 2404 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SAVVION_SBM` |
| 128 | DWMLN_SAVVION_WRKFL | 1 | 2405 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SAVVION_WRKFL` |
| 129 | Validations_DWMLN_SPEEDWARE | 1 | 2406 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SPEEDWARE` |
| 130 | SSL_METRO_STG | 1 | 2407 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SSL_METRO_STG` |
| 131 | Validations_DWMLN_SWIFT | 1 | 2408 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SWIFT` |
| 132 | DWMLN_SWIFT_INV | 1 | 2409 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_SWIFT_INV` |
| 133 | DWMLN_THREED_NOE | 1 | 2410 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_THREED_NOE` |
| 134 | DWMLN_UDL_FI | 1 | 2411 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_UDL_FI` |
| 135 | DWMLN_UDL_OPSBI | 1 | 2412 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_UDL_OPSBI` |
| 136 | Validations_DWMLN_WFMIMP1 | 1 | 2413 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_WFMIMP1` |
| 137 | Validations_DWMLN_WM | 1 | 2414 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_DWMLN_WM` |
| 138 | Cnt_Validations_ICSM | 1 | 2437 | 2 | `s_m_Load_Divestiture_Daily_Table_Cnt_Validations_ICSM` |

#### DG_4 — 137 members
- **Sources:** `AE2E_JOB_LOG`
- **Targets:** `TARGET_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STG_JOB_CHECK | 45 | 12948 | 1 | `s_m_AE2E_ACTIVE_STG_JOB_CHECK` |
| 2 | LOG_CHECK_DIS | 45 | 12949 | 1 | `s_m_AE2E_ADC_KENAN_PREP_LOG_CHECK_DIS` |
| 3 | LOG_CHECK_HIST | 45 | 12950 | 1 | `s_m_AE2E_ADC_KENAN_PREP_LOG_CHECK_HIST` |
| 4 | LOG_CHECK_INST | 45 | 12951 | 1 | `s_m_AE2E_ADC_KENAN_PREP_LOG_CHECK_INST` |
| 5 | AMT_LOG_CHECK | 45 | 12952 | 1 | `s_m_AE2E_AOB_AMT_LOG_CHECK` |
| 6 | ODW_LOG_CHECK | 45 | 12953 | 1 | `s_m_AE2E_AOB_ODW_LOG_CHECK` |
| 7 | XLINK_LOG_CHECK | 45 | 12954 | 1 | `s_m_AE2E_AOB_XLINK_LOG_CHECK` |
| 8 | ARC_LOG_CHECK | 45 | 12955 | 1 | `s_m_AE2E_ARC_CKT_ORD_ARC_LOG_CHECK` |
| 9 | ARC_LOG_CHECK | 45 | 12956 | 1 | `s_m_AE2E_ASOG_ARC_LOG_CHECK` |
| 10 | ASR_LOG_CHECK | 45 | 12957 | 1 | `s_m_AE2E_ASOG_ASR_LOG_CHECK` |
| 11 | WNI_LOG_CHECK | 45 | 12958 | 1 | `s_m_AE2E_BILLTRAK_PREP_WNI_LOG_CHECK` |
| 12 | WCD_LOG_CHECK | 45 | 12959 | 1 | `s_m_AE2E_BILL_TRAK_PREP_WCD_LOG_CHECK` |
| 13 | WND_LOG_CHECK | 45 | 12960 | 1 | `s_m_AE2E_BILL_TRAK_PREP_WND_LOG_CHECK` |
| 14 | PREP_LOG_CHECK | 45 | 12961 | 1 | `s_m_AE2E_BILL_TRAK_PRO_PREP_LOG_CHECK` |
| 15 | PREP_LOG_CHECK | 45 | 12962 | 1 | `s_m_AE2E_BTP_PREP_LOG_CHECK` |
| 16 | LOG_CHECK_DIS | 45 | 12963 | 1 | `s_m_AE2E_BTP_PREP_LOG_CHECK_DIS` |
| 17 | LOG_CHECK_INST | 45 | 12964 | 1 | `s_m_AE2E_BTP_PREP_LOG_CHECK_INST` |
| 18 | PREP_LOG_CHECK | 45 | 12965 | 1 | `s_m_AE2E_CVR_ASR_TO_ORDER_CODS_PREP_LOG_CHECK` |
| 19 | PREP_LOG_CHECK | 45 | 12966 | 1 | `s_m_AE2E_CVR_ASR_TO_ORDER_OFFNET_PREP_LOG_CHECK` |
| 20 | PREP_LOG_CHECK | 45 | 12967 | 1 | `s_m_AE2E_CVR_ASR_TO_ORDER_WORKFLOW_PREP_LOG_CHECK` |
| 21 | PREP_LOG_CHECK | 45 | 12968 | 1 | `s_m_AE2E_CVR_ORDER_TO_ASR_CODS_PREP_LOG_CHECK` |
| 22 | PREP_LOG_CHECK | 45 | 12969 | 1 | `s_m_AE2E_CVR_ORDER_TO_ASR_OFFNET_PREP_LOG_CHECK` |
| 23 | PREP_LOG_CHECK | 45 | 12970 | 1 | `s_m_AE2E_CVR_ORDER_TO_ASR_WORKFLOW_PREP_LOG_CHECK` |
| 24 | PREP_LOG_CHECK | 45 | 12971 | 1 | `s_m_AE2E_CVR_ORDER_TO_BPMS_CODS_PREP_LOG_CHECK` |
| 25 | PREP_LOG_CHECK | 45 | 12972 | 1 | `s_m_AE2E_CVR_ORDER_TO_BPMS_WORKFLOW_PREP_LOG_CHECK` |
| 26 | PREP_LOG_CHECK | 45 | 12973 | 1 | `s_m_AE2E_CVR_ORDER_TO_VBR_AMT_PREP_LOG_CHECK` |
| 27 | PREP_LOG_CHECK | 45 | 12974 | 1 | `s_m_AE2E_CVR_ORDER_TO_VBR_CODS_PREP_LOG_CHECK` |
| 28 | PREP_LOG_CHECK | 45 | 12975 | 1 | `s_m_AE2E_CVR_ORDER_TO_VBR_GRANITE_PREP_LOG_CHECK` |
| 29 | PATH_LOG_CHECK | 45 | 12976 | 1 | `s_m_AE2E_CVR_ORDER_TO_VBR_GRANITE_PREP_NETINV_PATH_LOG_CHECK` |
| 30 | AML_LOG_CHECK | 45 | 12977 | 1 | `s_m_AE2E_CVR_ORDER_TO_VBR_NETEX_PREP_AML_LOG_CHECK` |
| 31 | PREP_LOG_CHECK | 45 | 12978 | 1 | `s_m_AE2E_CVR_ORDER_TO_VBR_NETEX_PREP_LOG_CHECK` |
| 32 | PATH_LOG_CHECK | 45 | 12979 | 1 | `s_m_AE2E_CVR_ORDER_TO_VBR_NETEX_PREP_NETINV_PATH_LOG_CHECK` |
| 33 | PREP_LOG_CHECK | 45 | 12980 | 1 | `s_m_AE2E_CVR_ORDER_TO_VBR_OFFNET_PREP_LOG_CHECK` |
| 34 | PATH_LOG_CHECK | 45 | 12981 | 1 | `s_m_AE2E_CVR_ORDER_TO_VBR_OFFNET_PREP_NETINV_PATH_LOG_CHECK` |
| 35 | ARCHIVE_LOG_CHECK | 45 | 12982 | 1 | `s_m_AE2E_CV_ARCHIVE_LOG_CHECK` |
| 36 | STG_LOG_CHECK | 45 | 12983 | 1 | `s_m_AE2E_DES_TRK_ARC_STG_LOG_CHECK` |
| 37 | STG_LOG_CHECK | 45 | 12984 | 1 | `s_m_AE2E_DES_TRK_STG_LOG_CHECK` |
| 38 | PREP_LOG_CHECK | 45 | 12985 | 1 | `s_m_AE2E_FUSION_PREP_LOG_CHECK` |
| 39 | LOG_CHECK_HIST | 45 | 12986 | 1 | `s_m_AE2E_IDC_KEN_PREP_LOG_CHECK_HIST` |
| 40 | GRN_LOG_CHECK | 45 | 12987 | 1 | `s_m_AE2E_IOB_GRN_LOG_CHECK` |
| 41 | NG_LOG_CHECK | 45 | 12988 | 1 | `s_m_AE2E_IOB_NG_LOG_CHECK` |
| 42 | LOG_CHECK_DIS | 45 | 12989 | 1 | `s_m_AE2E_IXPLUS_PREP_LOG_CHECK_DIS` |
| 43 | LOG_CHECK_HIST | 45 | 12990 | 1 | `s_m_AE2E_IXPLUS_PREP_LOG_CHECK_HIST` |
| 44 | LOG_CHECK_INS | 45 | 12991 | 1 | `s_m_AE2E_IXPLUS_PREP_LOG_CHECK_INS` |
| 45 | PREP_LOG_CHECK | 45 | 12992 | 1 | `s_m_AE2E_KENAN_PREP_LOG_CHECK` |
| 46 | WCD_LOG_CHECK | 45 | 12993 | 1 | `s_m_AE2E_KENAN_PREP_WCD_LOG_CHECK` |
| 47 | LOG_CHECK_DIS | 45 | 12994 | 1 | `s_m_AE2E_KEN_PREP_LOG_CHECK_DIS` |
| 48 | LOG_CHECK_INS | 45 | 12995 | 1 | `s_m_AE2E_KEN_PREP_LOG_CHECK_INS` |
| 49 | LOG_CHECK_WCD | 45 | 12996 | 1 | `s_m_AE2E_ODW_PREP_LOG_CHECK_WCD` |
| 50 | LOG_CHECK_WCI | 45 | 12997 | 1 | `s_m_AE2E_ODW_PREP_LOG_CHECK_WCI` |
| 51 | LOG_CHECK_WFGDD | 45 | 12998 | 1 | `s_m_AE2E_ODW_PREP_LOG_CHECK_WFGDD` |
| 52 | LOG_CHECK_WFGDI | 45 | 12999 | 1 | `s_m_AE2E_ODW_PREP_LOG_CHECK_WFGDI` |
| 53 | LOG_CHECK_WND | 45 | 13000 | 1 | `s_m_AE2E_ODW_PREP_LOG_CHECK_WND` |
| 54 | LOG_CHECK_WNI | 45 | 13001 | 1 | `s_m_AE2E_ODW_PREP_LOG_CHECK_WNI` |
| 55 | PREP_LOG_CHECK | 45 | 13002 | 1 | `s_m_AE2E_ONM_PREP_LOG_CHECK` |
| 56 | WCD_LOG_CHECK | 45 | 13003 | 1 | `s_m_AE2E_ONM_PREP_WCD_LOG_CHECK` |
| 57 | WND_LOG_CHECK | 45 | 13004 | 1 | `s_m_AE2E_ONM_PREP_WND_LOG_CHECK` |
| 58 | WNI_LOG_CHECK | 45 | 13005 | 1 | `s_m_AE2E_ONM_PREP_WNI_LOG_CHECK` |
| 59 | PREP_LOG_CHECK | 45 | 13006 | 1 | `s_m_AE2E_OPENCI_PREP_LOG_CHECK` |
| 60 | WCD_LOG_CHECK | 45 | 13007 | 1 | `s_m_AE2E_OPENCI_PREP_WCD_LOG_CHECK` |
| 61 | WND_LOG_CHECK | 45 | 13008 | 1 | `s_m_AE2E_OPENCI_PREP_WND_LOG_CHECK` |
| 62 | WNI_LOG_CHECK | 45 | 13009 | 1 | `s_m_AE2E_OPENCI_PREP_WNI_LOG_CHECK` |
| 63 | PREP_LOG_CHECK | 45 | 13010 | 1 | `s_m_AE2E_REVAMART_PREP_LOG_CHECK` |
| 64 | WCD_LOG_CHECK | 45 | 13011 | 1 | `s_m_AE2E_REVAMART_PREP_WCD_LOG_CHECK` |
| 65 | LOG_CHECK_DIS | 45 | 13012 | 1 | `s_m_AE2E_REVA_PREP_LOG_CHECK_DIS` |
| 66 | LOG_CHECK_HIST | 45 | 13013 | 1 | `s_m_AE2E_REVA_PREP_LOG_CHECK_HIST` |
| 67 | LOG_CHECK_INS | 45 | 13014 | 1 | `s_m_AE2E_REVA_PREP_LOG_CHECK_INS` |
| 68 | PREP_LOG_CHECK | 45 | 13015 | 1 | `s_m_AE2E_SIEBEL_PREP_LOG_CHECK` |
| 69 | WCD_LOG_CHECK | 45 | 13016 | 1 | `s_m_AE2E_SIEBEL_PREP_WCD_LOG_CHECK` |
| 70 | PREP_LOG_CHECK | 45 | 13017 | 1 | `s_m_AE2E_UNITY_AMT_DIS_PREP_LOG_CHECK` |
| 71 | PREP_LOG_CHECK | 45 | 13018 | 1 | `s_m_AE2E_UNITY_AMT_PREP_LOG_CHECK` |
| 72 | PREP_LOG_CHECK | 45 | 13019 | 1 | `s_m_AE2E_UNITY_BPMS_DIS_PREP_LOG_CHECK` |
| 73 | PREP_LOG_CHECK | 45 | 13020 | 1 | `s_m_AE2E_UNITY_BPMS_PREP_LOG_CHECK` |
| 74 | PREP_LOG_CHECK | 45 | 13021 | 1 | `s_m_AE2E_UNITY_BTP_DIS_PREP_LOG_CHECK` |
| 75 | PREP_LOG_CHECK | 45 | 13022 | 1 | `s_m_AE2E_UNITY_BTP_PREP_LOG_CHECK` |
| 76 | PREP_LOG_CHECK | 45 | 13023 | 1 | `s_m_AE2E_UNITY_GRANITE_DIS_PREP_LOG_CHECK` |
| 77 | PREP_LOG_CHECK | 45 | 13024 | 1 | `s_m_AE2E_UNITY_GRANITE_PREP_LOG_CHECK` |
| 78 | PREP_LOG_CHECK | 45 | 13025 | 1 | `s_m_AE2E_UNITY_KENAN_DIS_PREP_LOG_CHECK` |
| 79 | PREP_LOG_CHECK | 45 | 13026 | 1 | `s_m_AE2E_UNITY_KENAN_PREP_LOG_CHECK` |
| 80 | PREP_LOG_CHECK | 45 | 13027 | 1 | `s_m_AE2E_UNITY_ND_AMT_PREP_LOG_CHECK` |
| 81 | PREP_LOG_CHECK | 45 | 13028 | 1 | `s_m_AE2E_UNITY_ND_BPMS_PREP_LOG_CHECK` |
| 82 | PREP_LOG_CHECK | 45 | 13029 | 1 | `s_m_AE2E_UNITY_ND_BTP_PREP_LOG_CHECK` |
| 83 | PREP_LOG_CHECK | 45 | 13030 | 1 | `s_m_AE2E_UNITY_ND_CLARIFY_PREP_LOG_CHECK` |
| 84 | PREP_LOG_CHECK | 45 | 13031 | 1 | `s_m_AE2E_UNITY_ND_CS_PREP_LOG_CHECK` |
| 85 | PREP_LOG_CHECK | 45 | 13032 | 1 | `s_m_AE2E_UNITY_ND_GRANITE_PREP_LOG_CHECK` |
| 86 | PREP_LOG_CHECK | 45 | 13033 | 1 | `s_m_AE2E_UNITY_ND_NG_PREP_LOG_CHECK` |
| 87 | PREP_LOG_CHECK | 45 | 13034 | 1 | `s_m_AE2E_UNITY_ND_ODW_PREP_LOG_CHECK` |
| 88 | PREP_LOG_CHECK | 45 | 13035 | 1 | `s_m_AE2E_UNITY_ND_RFA_PREP_LOG_CHECK` |
| 89 | PREP_LOG_CHECK | 45 | 13036 | 1 | `s_m_AE2E_UNITY_ND_TRAIL_PREP_LOG_CHECK` |
| 90 | PREP_LOG_CHECK | 45 | 13037 | 1 | `s_m_AE2E_UNITY_ND_XLINK_PREP_LOG_CHECK` |
| 91 | PREP_LOG_CHECK | 45 | 13038 | 1 | `s_m_AE2E_UNITY_NI_AMT_PREP_LOG_CHECK` |
| 92 | PREP_LOG_CHECK | 45 | 13039 | 1 | `s_m_AE2E_UNITY_NI_BPMS_PREP_LOG_CHECK` |
| 93 | PREP_LOG_CHECK | 45 | 13040 | 1 | `s_m_AE2E_UNITY_NI_BTP_PREP_LOG_CHECK` |
| 94 | PREP_LOG_CHECK | 45 | 13041 | 1 | `s_m_AE2E_UNITY_NI_CFY_PREP_LOG_CHECK` |
| 95 | PREP_LOG_CHECK | 45 | 13042 | 1 | `s_m_AE2E_UNITY_NI_CS_PREP_LOG_CHECK` |
| 96 | PREP_LOG_CHECK | 45 | 13043 | 1 | `s_m_AE2E_UNITY_NI_GRANITE_PREP_LOG_CHECK` |
| 97 | PREP_LOG_CHECK | 45 | 13044 | 1 | `s_m_AE2E_UNITY_NI_NG_PREP_LOG_CHECK` |
| 98 | PREP_LOG_CHECK | 45 | 13045 | 1 | `s_m_AE2E_UNITY_NI_ODW_PREP_LOG_CHECK` |
| 99 | PREP_LOG_CHECK | 45 | 13046 | 1 | `s_m_AE2E_UNITY_NI_RFA_PREP_LOG_CHECK` |
| 100 | PREP_LOG_CHECK | 45 | 13047 | 1 | `s_m_AE2E_UNITY_NI_TRAIL_PREP_LOG_CHECK` |
| 101 | PREP_LOG_CHECK | 45 | 13048 | 1 | `s_m_AE2E_UNITY_NI_XLINK_PREP_LOG_CHECK` |
| 102 | PREP_LOG_CHECK | 45 | 13049 | 1 | `s_m_AE2E_UNITY_ODW_DIS_PREP_LOG_CHECK` |
| 103 | PREP_LOG_CHECK | 45 | 13050 | 1 | `s_m_AE2E_UNITY_ODW_PREP_LOG_CHECK` |
| 104 | PREP_LOG_CHECK | 45 | 13051 | 1 | `s_m_AE2E_UNITY_ONT_CUSDIS_BPMS_PREP_LOG_CHECK` |
| 105 | PREP_LOG_CHECK | 45 | 13052 | 1 | `s_m_AE2E_UNITY_ONT_CUSDIS_CS_PREP_LOG_CHECK` |
| 106 | PREP_LOG_CHECK | 45 | 13053 | 1 | `s_m_AE2E_UNITY_ONT_CUSDIS_GRANITE_PREP_LOG_CHECK` |
| 107 | PREP_LOG_CHECK | 45 | 13054 | 1 | `s_m_AE2E_UNITY_ONT_CUSDIS_KENAN_PREP_LOG_CHECK` |
| 108 | PREP_LOG_CHECK | 45 | 13055 | 1 | `s_m_AE2E_UNITY_ONT_CUSDIS_PIPELINE_PREP_LOG_CHECK` |
| 109 | PREP_LOG_CHECK | 45 | 13056 | 1 | `s_m_AE2E_UNITY_ONT_CUSDIS_REVMART_PREP_LOG_CHECK` |
| 110 | PREP_LOG_CHECK | 45 | 13057 | 1 | `s_m_AE2E_UNITY_ONT_CUSDIS_SIEBEL_PREP_LOG_CHECK` |
| 111 | PREP_LOG_CHECK | 45 | 13058 | 1 | `s_m_AE2E_UNITY_ONT_CUSINS_BPMS_PREP_LOG_CHECK` |
| 112 | PREP_LOG_CHECK | 45 | 13059 | 1 | `s_m_AE2E_UNITY_ONT_CUSINS_CS_PREP_LOG_CHECK` |
| 113 | PREP_LOG_CHECK | 45 | 13060 | 1 | `s_m_AE2E_UNITY_ONT_CUSINS_GRANITE_PREP_LOG_CHECK` |
| 114 | PREP_LOG_CHECK | 45 | 13061 | 1 | `s_m_AE2E_UNITY_ONT_CUSINS_KENAN_PREP_LOG_CHECK` |
| 115 | PREP_LOG_CHECK | 45 | 13062 | 1 | `s_m_AE2E_UNITY_ONT_CUSINS_PIPELINE_PREP_LOG_CHECK` |
| 116 | PREP_LOG_CHECK | 45 | 13063 | 1 | `s_m_AE2E_UNITY_ONT_CUSINS_REVMART_PREP_LOG_CHECK` |
| 117 | PREP_LOG_CHECK | 45 | 13064 | 1 | `s_m_AE2E_UNITY_ONT_CUSINS_SIEBEL_PREP_LOG_CHECK` |
| 118 | PREP_LOG_CHECK | 45 | 13065 | 1 | `s_m_AE2E_UNITY_PIPELINE_DIS_PREP_LOG_CHECK` |
| 119 | PREP_LOG_CHECK | 45 | 13066 | 1 | `s_m_AE2E_UNITY_PIPELINE_INS_PREP_LOG_CHECK` |
| 120 | PREP_LOG_CHECK | 45 | 13067 | 1 | `s_m_AE2E_UNITY_REVMART_DIS_PREP_LOG_CHECK` |
| 121 | PREP_LOG_CHECK | 45 | 13068 | 1 | `s_m_AE2E_UNITY_REVMART_PREP_LOG_CHECK` |
| 122 | PREP_LOG_CHECK | 45 | 13069 | 1 | `s_m_AE2E_UNITY_SIEBEL_DIS_PREP_LOG_CHECK` |
| 123 | PREP_LOG_CHECK | 45 | 13070 | 1 | `s_m_AE2E_UNITY_SIEBEL_PREP_LOG_CHECK` |
| 124 | PREP_LOG_CHECK | 45 | 13071 | 1 | `s_m_AE2E_UNITY_XLINK_DIS_PREP_LOG_CHECK` |
| 125 | PREP_LOG_CHECK | 45 | 13072 | 1 | `s_m_AE2E_UNITY_XLINK_PREP_LOG_CHECK` |
| 126 | PREP_LOG_CHECK | 45 | 13073 | 1 | `s_m_AE2E_VYVX_BTP_PREP_LOG_CHECK` |
| 127 | PREP_LOG_CHECK | 45 | 13074 | 1 | `s_m_AE2E_VYVX_VBUS_PREP_LOG_CHECK` |
| 128 | PREP_LOG_CHECK | 45 | 13075 | 1 | `s_m_AE2E_XLINK_CV_PREP_LOG_CHECK` |
| 129 | LOG_CHECK_DIS | 45 | 13076 | 1 | `s_m_AE2E_XLINK_CV_PREP_LOG_CHECK_DIS` |
| 130 | LOG_CHECK_INST | 45 | 13077 | 1 | `s_m_AE2E_XLINK_CV_PREP_LOG_CHECK_INST` |
| 131 | PREP_LOG_CHECK | 45 | 13078 | 1 | `s_m_BILL_TRAK_FGDD_PREP_LOG_CHECK` |
| 132 | PREP_LOG_CHECK | 45 | 13079 | 1 | `s_m_BTP_FGDI_PREP_LOG_CHECK` |
| 133 | LOGICAL_LOG_CHECK | 45 | 13080 | 1 | `s_m_DNR_GRANITE_LOGICAL_LOG_CHECK` |
| 134 | PREP_LOG_CHECK | 45 | 13081 | 1 | `s_m_OFFNET_MGR_FGDD_PREP_LOG_CHECK` |
| 135 | PREP_LOG_CHECK | 45 | 13082 | 1 | `s_m_OFFNET_MGR_FGDI_PREP_LOG_CHECK` |
| 136 | PREP_LOG_CHECK | 45 | 13083 | 1 | `s_m_OPENCI_MGR_FGDD_PREP_LOG_CHECK` |
| 137 | PREP_LOG_CHECK | 45 | 13084 | 1 | `s_m_OPENCI_MGR_FGDI_PREP_LOG_CHECK` |

#### DG_5 — 136 members
- **Sources:** `MONTHS_PROCESSED`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUST_CUBE_EXTRACT | 1 | 5446 | 13 | `s_m_Load_SWP_F_CUST_CUBE_EXTRACT` |
| 2 | CUBE_EXTRACT_RANK1 | 1 | 5447 | 13 | `s_m_Load_SWP_F_CUST_CUBE_EXTRACT_RANK1` |
| 3 | CUBE_EXTRACT_RANK2 | 1 | 5448 | 13 | `s_m_Load_SWP_F_CUST_CUBE_EXTRACT_RANK2` |
| 4 | CUBE_EXTRACT_RANK3 | 1 | 5449 | 13 | `s_m_Load_SWP_F_CUST_CUBE_EXTRACT_RANK3` |
| 5 | CUBE_EXTRACT_RANK4 | 1 | 5450 | 13 | `s_m_Load_SWP_F_CUST_CUBE_EXTRACT_RANK4` |
| 6 | CUBE_EXTRACT_RANK5 | 1 | 5451 | 13 | `s_m_Load_SWP_F_CUST_CUBE_EXTRACT_RANK5` |
| 7 | CUBE_EXTRACT_RANK6 | 1 | 5452 | 13 | `s_m_Load_SWP_F_CUST_CUBE_EXTRACT_RANK6` |
| 8 | BALANCE_ALL_RANK1 | 1 | 5453 | 12 | `s_m_Load_SWP_F_GL_BALANCE_ALL_RANK1` |
| 9 | BALANCE_ALL_RANK2 | 1 | 5454 | 12 | `s_m_Load_SWP_F_GL_BALANCE_ALL_RANK2` |
| 10 | BALANCE_ALL_RANK3 | 1 | 5455 | 12 | `s_m_Load_SWP_F_GL_BALANCE_ALL_RANK3` |
| 11 | BALANCE_ALL_RANK4 | 1 | 5456 | 12 | `s_m_Load_SWP_F_GL_BALANCE_ALL_RANK4` |
| 12 | BALANCE_ALL_RANK5 | 1 | 5457 | 12 | `s_m_Load_SWP_F_GL_BALANCE_ALL_RANK5` |
| 13 | BALANCE_ALL_RANK6 | 1 | 5458 | 12 | `s_m_Load_SWP_F_GL_BALANCE_ALL_RANK6` |
| 14 | F_GL_DETAIL | 1 | 5459 | 13 | `s_m_Load_SWP_F_GL_DETAIL` |
| 15 | GL_DETAIL_RANK1 | 1 | 5460 | 13 | `s_m_Load_SWP_F_GL_DETAIL_RANK1` |
| 16 | GL_DETAIL_RANK2 | 1 | 5461 | 13 | `s_m_Load_SWP_F_GL_DETAIL_RANK2` |
| 17 | GL_DETAIL_RANK3 | 1 | 5462 | 13 | `s_m_Load_SWP_F_GL_DETAIL_RANK3` |
| 18 | GL_DETAIL_RANK4 | 1 | 5463 | 13 | `s_m_Load_SWP_F_GL_DETAIL_RANK4` |
| 19 | GL_DETAIL_RANK5 | 1 | 5464 | 13 | `s_m_Load_SWP_F_GL_DETAIL_RANK5` |
| 20 | GL_DETAIL_RANK6 | 1 | 5465 | 13 | `s_m_Load_SWP_F_GL_DETAIL_RANK6` |
| 21 | F_JOURNAL_SUMMARY | 1 | 5473 | 13 | `s_m_Load_SWP_F_JOURNAL_SUMMARY` |
| 22 | JOURNAL_SUMMARY_RANK1 | 1 | 5474 | 13 | `s_m_Load_SWP_F_JOURNAL_SUMMARY_RANK1` |
| 23 | JOURNAL_SUMMARY_RANK2 | 1 | 5475 | 13 | `s_m_Load_SWP_F_JOURNAL_SUMMARY_RANK2` |
| 24 | JOURNAL_SUMMARY_RANK3 | 1 | 5476 | 13 | `s_m_Load_SWP_F_JOURNAL_SUMMARY_RANK3` |
| 25 | JOURNAL_SUMMARY_RANK4 | 1 | 5477 | 13 | `s_m_Load_SWP_F_JOURNAL_SUMMARY_RANK4` |
| 26 | JOURNAL_SUMMARY_RANK5 | 1 | 5478 | 13 | `s_m_Load_SWP_F_JOURNAL_SUMMARY_RANK5` |
| 27 | JOURNAL_SUMMARY_RANK6 | 1 | 5479 | 13 | `s_m_Load_SWP_F_JOURNAL_SUMMARY_RANK6` |
| 28 | NETEX_DETAIL_RANK1 | 1 | 5487 | 13 | `s_m_Load_SWP_F_NETEX_DETAIL_RANK1` |
| 29 | NETEX_DETAIL_RANK2 | 1 | 5488 | 13 | `s_m_Load_SWP_F_NETEX_DETAIL_RANK2` |
| 30 | NETEX_DETAIL_RANK3 | 1 | 5489 | 13 | `s_m_Load_SWP_F_NETEX_DETAIL_RANK3` |
| 31 | NETEX_DETAIL_RANK4 | 1 | 5490 | 13 | `s_m_Load_SWP_F_NETEX_DETAIL_RANK4` |
| 32 | NETEX_DETAIL_RANK5 | 1 | 5491 | 13 | `s_m_Load_SWP_F_NETEX_DETAIL_RANK5` |
| 33 | NETEX_DETAIL_RANK6 | 1 | 5492 | 13 | `s_m_Load_SWP_F_NETEX_DETAIL_RANK6` |
| 34 | CUST_EXTRACT_RANK1 | 1 | 5506 | 13 | `s_m_Load_SWP_F_REVENUE_CUST_EXTRACT_RANK1` |
| 35 | CUST_EXTRACT_RANK2 | 1 | 5507 | 13 | `s_m_Load_SWP_F_REVENUE_CUST_EXTRACT_RANK2` |
| 36 | CUST_EXTRACT_RANK3 | 1 | 5508 | 13 | `s_m_Load_SWP_F_REVENUE_CUST_EXTRACT_RANK3` |
| 37 | CUST_EXTRACT_RANK4 | 1 | 5509 | 13 | `s_m_Load_SWP_F_REVENUE_CUST_EXTRACT_RANK4` |
| 38 | CUST_EXTRACT_RANK5 | 1 | 5510 | 13 | `s_m_Load_SWP_F_REVENUE_CUST_EXTRACT_RANK5` |
| 39 | CUST_EXTRACT_RANK6 | 1 | 5511 | 13 | `s_m_Load_SWP_F_REVENUE_CUST_EXTRACT_RANK6` |
| 40 | REVENUE_DETAIL_ALL | 1 | 5512 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL` |
| 41 | ALL_CABS_RANK1 | 1 | 5513 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_CABS_RANK1` |
| 42 | ALL_CABS_RANK2 | 1 | 5514 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_CABS_RANK2` |
| 43 | ALL_CABS_RANK3 | 1 | 5515 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_CABS_RANK3` |
| 44 | ALL_CABS_RANK4 | 1 | 5516 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_CABS_RANK4` |
| 45 | ALL_CABS_RANK5 | 1 | 5517 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_CABS_RANK5` |
| 46 | ALL_CABS_RANK6 | 1 | 5518 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_CABS_RANK6` |
| 47 | ALL_KENAN_RANK1 | 1 | 5519 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK1` |
| 48 | ALL_KENAN_RANK12 | 1 | 5520 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK12` |
| 49 | ALL_KENAN_RANK2 | 1 | 5521 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK2` |
| 50 | ALL_KENAN_RANK22 | 1 | 5522 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK22` |
| 51 | ALL_KENAN_RANK3 | 1 | 5523 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK3` |
| 52 | ALL_KENAN_RANK32 | 1 | 5524 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK32` |
| 53 | ALL_KENAN_RANK4 | 1 | 5525 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK4` |
| 54 | ALL_KENAN_RANK42 | 1 | 5526 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK42` |
| 55 | ALL_KENAN_RANK5 | 1 | 5527 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK5` |
| 56 | ALL_KENAN_RANK52 | 1 | 5528 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK52` |
| 57 | ALL_KENAN_RANK6 | 1 | 5529 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK6` |
| 58 | ALL_KENAN_RANK62 | 1 | 5530 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_KENAN_RANK62` |
| 59 | ALL_NIBS_RANK1 | 1 | 5531 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_NIBS_RANK1` |
| 60 | ALL_NIBS_RANK2 | 1 | 5532 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_NIBS_RANK2` |
| 61 | ALL_NIBS_RANK3 | 1 | 5533 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_NIBS_RANK3` |
| 62 | ALL_NIBS_RANK4 | 1 | 5534 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_NIBS_RANK4` |
| 63 | ALL_NIBS_RANK5 | 1 | 5535 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_NIBS_RANK5` |
| 64 | ALL_NIBS_RANK6 | 1 | 5536 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_NIBS_RANK6` |
| 65 | DETAIL_ALL_RANK1 | 1 | 5537 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_RANK1` |
| 66 | DETAIL_ALL_RANK2 | 1 | 5538 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_RANK2` |
| 67 | DETAIL_ALL_RANK3 | 1 | 5539 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_RANK3` |
| 68 | DETAIL_ALL_RANK4 | 1 | 5540 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_RANK4` |
| 69 | DETAIL_ALL_RANK5 | 1 | 5541 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_RANK5` |
| 70 | DETAIL_ALL_RANK6 | 1 | 5542 | 13 | `s_m_Load_SWP_F_REVENUE_DETAIL_ALL_RANK6` |
| 71 | REVENUE_INVOICE_SUM | 1 | 5543 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM` |
| 72 | SUM_CABS_RANK1 | 1 | 5544 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_CABS_RANK1` |
| 73 | SUM_CABS_RANK2 | 1 | 5545 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_CABS_RANK2` |
| 74 | SUM_CABS_RANK3 | 1 | 5546 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_CABS_RANK3` |
| 75 | SUM_CABS_RANK4 | 1 | 5547 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_CABS_RANK4` |
| 76 | SUM_CABS_RANK5 | 1 | 5548 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_CABS_RANK5` |
| 77 | SUM_CABS_RANK6 | 1 | 5549 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_CABS_RANK6` |
| 78 | SUM_DASSIAN_RANK | 1 | 5550 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_DASSIAN_RANK` |
| 79 | SUM_DASSIAN_RANK1 | 1 | 5551 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_DASSIAN_RANK1` |
| 80 | SUM_DASSIAN_RANK2 | 1 | 5552 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_DASSIAN_RANK2` |
| 81 | SUM_DASSIAN_RANK3 | 1 | 5553 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_DASSIAN_RANK3` |
| 82 | SUM_DASSIAN_RANK4 | 1 | 5554 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_DASSIAN_RANK4` |
| 83 | SUM_DASSIAN_RANK5 | 1 | 5555 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_DASSIAN_RANK5` |
| 84 | SUM_DASSIAN_RANK6 | 1 | 5556 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_DASSIAN_RANK6` |
| 85 | INVOICE_SUM_ENS | 1 | 5557 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_ENS` |
| 86 | SUM_KENAN_RANK1 | 1 | 5558 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_KENAN_RANK1` |
| 87 | SUM_KENAN_RANK2 | 1 | 5559 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_KENAN_RANK2` |
| 88 | SUM_KENAN_RANK3 | 1 | 5560 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_KENAN_RANK3` |
| 89 | SUM_KENAN_RANK4 | 1 | 5561 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_KENAN_RANK4` |
| 90 | SUM_KENAN_RANK5 | 1 | 5562 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_KENAN_RANK5` |
| 91 | SUM_KENAN_RANK6 | 1 | 5563 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_KENAN_RANK6` |
| 92 | SUM_MBS_RANK1 | 1 | 5564 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_MBS_RANK1` |
| 93 | SUM_MBS_RANK2 | 1 | 5565 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_MBS_RANK2` |
| 94 | SUM_MBS_RANK3 | 1 | 5566 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_MBS_RANK3` |
| 95 | SUM_MBS_RANK4 | 1 | 5567 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_MBS_RANK4` |
| 96 | SUM_MBS_RANK5 | 1 | 5568 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_MBS_RANK5` |
| 97 | SUM_MBS_RANK6 | 1 | 5569 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_MBS_RANK6` |
| 98 | SUM_NIBS_RANK1 | 1 | 5570 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_NIBS_RANK1` |
| 99 | SUM_NIBS_RANK2 | 1 | 5571 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_NIBS_RANK2` |
| 100 | SUM_NIBS_RANK3 | 1 | 5572 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_NIBS_RANK3` |
| 101 | SUM_NIBS_RANK4 | 1 | 5573 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_NIBS_RANK4` |
| 102 | SUM_NIBS_RANK5 | 1 | 5574 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_NIBS_RANK5` |
| 103 | SUM_NIBS_RANK6 | 1 | 5575 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_NIBS_RANK6` |
| 104 | INVOICE_SUM_RANK1 | 1 | 5576 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_RANK1` |
| 105 | INVOICE_SUM_RANK2 | 1 | 5577 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_RANK2` |
| 106 | INVOICE_SUM_RANK3 | 1 | 5578 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_RANK3` |
| 107 | INVOICE_SUM_RANK4 | 1 | 5579 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_RANK4` |
| 108 | INVOICE_SUM_RANK5 | 1 | 5580 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_RANK5` |
| 109 | INVOICE_SUM_RANK6 | 1 | 5581 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_RANK6` |
| 110 | INVOICE_SUM_RJF | 1 | 5582 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_RJF` |
| 111 | INVOICE_SUM_ZUORA | 1 | 5583 | 14 | `s_m_Load_SWP_F_REVENUE_INVOICE_SUM_ZUORA` |
| 112 | F_REVENUE_SUMMARY | 1 | 5584 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY` |
| 113 | SUMMARY_CABS_RANK1 | 1 | 5585 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_CABS_RANK1` |
| 114 | SUMMARY_CABS_RANK2 | 1 | 5586 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_CABS_RANK2` |
| 115 | SUMMARY_CABS_RANK3 | 1 | 5587 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_CABS_RANK3` |
| 116 | SUMMARY_CABS_RANK4 | 1 | 5588 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_CABS_RANK4` |
| 117 | SUMMARY_CABS_RANK5 | 1 | 5589 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_CABS_RANK5` |
| 118 | SUMMARY_CABS_RANK6 | 1 | 5590 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_CABS_RANK6` |
| 119 | SUMMARY_KENAN_RANK1 | 1 | 5591 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_KENAN_RANK1` |
| 120 | SUMMARY_KENAN_RANK2 | 1 | 5592 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_KENAN_RANK2` |
| 121 | SUMMARY_KENAN_RANK3 | 1 | 5593 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_KENAN_RANK3` |
| 122 | SUMMARY_KENAN_RANK4 | 1 | 5594 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_KENAN_RANK4` |
| 123 | SUMMARY_KENAN_RANK5 | 1 | 5595 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_KENAN_RANK5` |
| 124 | SUMMARY_KENAN_RANK6 | 1 | 5596 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_KENAN_RANK6` |
| 125 | SUMMARY_NIBS_RANK1 | 1 | 5597 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_NIBS_RANK1` |
| 126 | SUMMARY_NIBS_RANK2 | 1 | 5598 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_NIBS_RANK2` |
| 127 | SUMMARY_NIBS_RANK3 | 1 | 5599 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_NIBS_RANK3` |
| 128 | SUMMARY_NIBS_RANK4 | 1 | 5600 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_NIBS_RANK4` |
| 129 | SUMMARY_NIBS_RANK5 | 1 | 5601 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_NIBS_RANK5` |
| 130 | SUMMARY_NIBS_RANK6 | 1 | 5602 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_NIBS_RANK6` |
| 131 | REVENUE_SUMMARY_RANK1 | 1 | 5603 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_RANK1` |
| 132 | REVENUE_SUMMARY_RANK2 | 1 | 5604 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_RANK2` |
| 133 | REVENUE_SUMMARY_RANK3 | 1 | 5605 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_RANK3` |
| 134 | REVENUE_SUMMARY_RANK4 | 1 | 5606 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_RANK4` |
| 135 | REVENUE_SUMMARY_RANK5 | 1 | 5607 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_RANK5` |
| 136 | REVENUE_SUMMARY_RANK6 | 1 | 5608 | 13 | `s_m_Load_SWP_F_REVENUE_SUMMARY_RANK6` |

#### DG_6 — 121 members
- **Sources:** `DUMMY_SRC_DW_SEC_COM_NBR`
- **Targets:** `DUMMY_TGT_DW_SEC_COM_NBR`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_ACTIVITY_CPO | 1 | 6904 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_LINE_ORDER_ACTIVITY_CPO` |
| 2 | ORDER_ACTIVITY_NS | 1 | 6905 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_LINE_ORDER_ACTIVITY_NS` |
| 3 | ORDER_ACTIVITY_SLDB | 1 | 6906 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_LINE_ORDER_ACTIVITY_SLDB` |
| 4 | LINE_ORDER_CPO | 1 | 6907 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_LINE_ORDER_CPO` |
| 5 | LINE_ORDER_NS | 1 | 6908 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_LINE_ORDER_NS` |
| 6 | ORDER_PRICE_CPO | 1 | 6909 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_LINE_ORDER_PRICE_CPO` |
| 7 | ORDER_PRICE_NS | 1 | 6910 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_LINE_ORDER_PRICE_NS` |
| 8 | ORDER_PRICE_SLDB | 1 | 6911 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_LINE_ORDER_PRICE_SLDB` |
| 9 | LINE_ORDER_SLDB | 1 | 6912 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_LINE_ORDER_SLDB` |
| 10 | TN_ORDER_CPO | 1 | 6913 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_ORDER_CPO` |
| 11 | TN_ORDER_NS | 1 | 6914 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_ORDER_NS` |
| 12 | TN_ORDER_SLDB | 1 | 6915 | 2 | `s_m_Update_DW_SECURE_COMAPNY_NBR_TN_ORDER_SLDB` |
| 13 | COMPANY_NBR_OPPORTUNITY | 1 | 6938 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_OPPORTUNITY` |
| 14 | NBR_OPPTY_ATTR | 1 | 6939 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_OPPTY_ATTR` |
| 15 | NBR_OPPTY_PRODUCT | 1 | 6940 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_OPPTY_PRODUCT` |
| 16 | COMPANY_NBR_PROPOSAL | 1 | 6941 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_PROPOSAL` |
| 17 | COMPANY_NBR_QUOTE | 1 | 6942 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_QUOTE` |
| 18 | NBR_QUOTE_PRODUCT | 1 | 6943 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_QUOTE_PRODUCT` |
| 19 | QUOTE_PRODUCT_COMPNT | 1 | 6944 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_QUOTE_PRODUCT_COMPNT` |
| 20 | QUOTE_PRODUCT_ENDPNT | 1 | 6945 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_QUOTE_PRODUCT_ENDPNT` |
| 21 | PROD_COMPNT_ENDPNT | 1 | 6946 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_QUOTE_PROD_COMPNT_ENDPNT` |
| 22 | PROD_COMPNT_PRICE | 1 | 6947 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_QUOTE_PROD_COMPNT_PRICE` |
| 23 | NBR_QUOTE_PROPOSAL | 1 | 6948 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_QUOTE_PROPOSAL` |
| 24 | NBR_ASSET_PRODUCT | 1 | 7632 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT` |
| 25 | ASSET_PRODUCT_COMPNT | 1 | 7633 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_COMPNT` |
| 26 | PRODUCT_COMPNT_ENS | 1 | 7634 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_COMPNT_ENS` |
| 27 | PRODUCT_COMPNT_LEGACY | 1 | 7635 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_COMPNT_LEGACY` |
| 28 | ASSET_PRODUCT_ENDPNT | 1 | 7636 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_ENDPNT` |
| 29 | PRODUCT_ENDPNT_ENS | 1 | 7637 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_ENDPNT_ENS` |
| 30 | PRODUCT_ENDPNT_LEGACY | 1 | 7638 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_ENDPNT_LEGACY` |
| 31 | ASSET_PRODUCT_ENS | 1 | 7639 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_ENS` |
| 32 | ASSET_PRODUCT_LEGACY | 1 | 7640 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_LEGACY` |
| 33 | ASSET_PRODUCT_PRICE | 1 | 7641 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_PRICE` |
| 34 | PRODUCT_PRICE_ENS | 1 | 7642 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_PRICE_ENS` |
| 35 | PRODUCT_PRICE_LEGACY | 1 | 7643 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PRODUCT_PRICE_LEGACY` |
| 36 | PROD_COMPNT_ENDPNT | 1 | 7644 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PROD_COMPNT_ENDPNT` |
| 37 | COMPNT_ENDPNT_ENS | 1 | 7645 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PROD_COMPNT_ENDPNT_ENS` |
| 38 | COMPNT_ENDPNT_LEGACY | 1 | 7646 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PROD_COMPNT_ENDPNT_LEGACY` |
| 39 | PROD_COMPNT_PRICE | 1 | 7647 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PROD_COMPNT_PRICE` |
| 40 | COMPNT_PRICE_ENS | 1 | 7648 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PROD_COMPNT_PRICE_ENS` |
| 41 | COMPNT_PRICE_LEGACY | 1 | 7649 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_PROD_COMPNT_PRICE_LEGACY` |
| 42 | NBR_ASSET_RELATIONSHIP | 1 | 7650 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_RELATIONSHIP` |
| 43 | ASSET_RELATIONSHIP_ENS | 1 | 7651 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_RELATIONSHIP_ENS` |
| 44 | ASSET_RELATIONSHIP_LEGACY | 1 | 7652 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ASSET_RELATIONSHIP_LEGACY` |
| 45 | COMPANY_NBR_CONTACT | 1 | 7655 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CONTACT` |
| 46 | NBR_CUSTOMER_ATTRIBUTION | 1 | 7656 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ATTRIBUTION` |
| 47 | CUSTOMER_NUMBER_XREF | 1 | 7657 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_NUMBER_XREF` |
| 48 | NBR_CUSTOMER_ORDER | 1 | 7658 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER` |
| 49 | CUSTOMER_ORDER_BLUEMARBLE | 1 | 7659 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER_BLUEMARBLE` |
| 50 | CUSTOMER_ORDER_ENS | 1 | 7660 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER_ENS` |
| 51 | ORDER_ENS_MM | 1 | 7661 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER_ENS_MM` |
| 52 | CUSTOMER_ORDER_PRODUCT | 1 | 7662 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER_PRODUCT` |
| 53 | ORDER_PRODUCT_BLUEMARBLE | 1 | 7663 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER_PRODUCT_BLUEMARBLE` |
| 54 | ORDER_PRODUCT_ENS | 1 | 7664 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER_PRODUCT_ENS` |
| 55 | PRODUCT_ENS_MM | 1 | 7665 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER_PRODUCT_ENS_MM` |
| 56 | PRODUCT_SALESFORCE_FIBER | 1 | 7666 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER_PRODUCT_SALESFORCE_FIBER` |
| 57 | ORDER_SALESFORCE_FIBER | 1 | 7667 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CUSTOMER_ORDER_SALESFORCE_FIBER` |
| 58 | NBR_ORDER_ACTIVITY | 1 | 7679 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_ACTIVITY` |
| 59 | ORDER_ACTIVITY_BLUEMARBLE | 1 | 7680 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_ACTIVITY_BLUEMARBLE` |
| 60 | ORDER_ACTIVITY_ENS | 1 | 7681 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_ACTIVITY_ENS` |
| 61 | ACTIVITY_ENS_MM | 1 | 7682 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_ACTIVITY_ENS_MM` |
| 62 | ACTIVITY_SALESFORCE_FIBER | 1 | 7683 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_ACTIVITY_SALESFORCE_FIBER` |
| 63 | ORDER_PRODUCT_COMPNT | 1 | 7684 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_COMPNT` |
| 64 | PRODUCT_COMPNT_BLUEMARBLE | 1 | 7685 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_COMPNT_BLUEMARBLE` |
| 65 | PRODUCT_COMPNT_ENS | 1 | 7686 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_COMPNT_ENS` |
| 66 | COMPNT_ENS_MM | 1 | 7687 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_COMPNT_ENS_MM` |
| 67 | COMPNT_SALESFORCE_FIBER | 1 | 7688 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_COMPNT_SALESFORCE_FIBER` |
| 68 | ORDER_PRODUCT_ELEMENT | 1 | 7689 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ELEMENT` |
| 69 | PRODUCT_ELEMENT_BLUEMARBLE | 1 | 7690 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ELEMENT_BLUEMARBLE` |
| 70 | PRODUCT_ELEMENT_ENS | 1 | 7691 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ELEMENT_ENS` |
| 71 | ELEMENT_ENS_MM | 1 | 7692 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ELEMENT_ENS_MM` |
| 72 | ELEMENT_SALESFORCE_FIBER | 1 | 7693 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ELEMENT_SALESFORCE_FIBER` |
| 73 | ORDER_PRODUCT_ENDPNT | 1 | 7694 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ENDPNT` |
| 74 | PRODUCT_ENDPNT_BLUEMARBLE | 1 | 7695 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ENDPNT_BLUEMARBLE` |
| 75 | PRODUCT_ENDPNT_ENS | 1 | 7696 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ENDPNT_ENS` |
| 76 | ENDPNT_ENS_MM | 1 | 7697 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ENDPNT_ENS_MM` |
| 77 | ENDPNT_SALESFORCE_FIBER | 1 | 7698 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_ENDPNT_SALESFORCE_FIBER` |
| 78 | PRODUCT_INCR_AMT | 1 | 7699 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_INCR_AMT` |
| 79 | INCR_AMT_BLUEMARBLE | 1 | 7700 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_INCR_AMT_BLUEMARBLE` |
| 80 | INCR_AMT_ENS | 1 | 7701 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_INCR_AMT_ENS` |
| 81 | AMT_ENS_MM | 1 | 7702 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_INCR_AMT_ENS_MM` |
| 82 | AMT_SALESFORCE_FIBER | 1 | 7703 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_INCR_AMT_SALESFORCE_FIBER` |
| 83 | ORDER_PRODUCT_PRICE | 1 | 7704 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_PRICE` |
| 84 | PRODUCT_PRICE_BLUEMARBLE | 1 | 7705 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_PRICE_BLUEMARBLE` |
| 85 | PRODUCT_PRICE_ENS | 1 | 7706 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_PRICE_ENS` |
| 86 | PRICE_ENS_MM | 1 | 7707 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_PRICE_ENS_MM` |
| 87 | PRICE_SALESFORCE_FIBER | 1 | 7708 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_PRODUCT_PRICE_SALESFORCE_FIBER` |
| 88 | NBR_ORDER_RELATIONSHIP | 1 | 7709 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_RELATIONSHIP` |
| 89 | ORDER_RELATIONSHIP_BLUEMARBLE | 1 | 7710 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_RELATIONSHIP_BLUEMARBLE` |
| 90 | ORDER_RELATIONSHIP_ENS | 1 | 7711 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_RELATIONSHIP_ENS` |
| 91 | RELATIONSHIP_ENS_MM | 1 | 7712 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_RELATIONSHIP_ENS_MM` |
| 92 | RELATIONSHIP_SALESFORCE_FIBER | 1 | 7713 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ORDER_RELATIONSHIP_SALESFORCE_FIBER` |
| 93 | PRODUCT_COMPNT_ENDPNT | 1 | 7716 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_ENDPNT` |
| 94 | COMPNT_ENDPNT_BLUEMARBLE | 1 | 7717 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_ENDPNT_BLUEMARBLE` |
| 95 | COMPNT_ENDPNT_ENS | 1 | 7718 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_ENDPNT_ENS` |
| 96 | ENDPNT_ENS_MM | 1 | 7719 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_ENDPNT_ENS_MM` |
| 97 | ENDPNT_SALESFORCE_FIBER | 1 | 7720 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_ENDPNT_SALESFORCE_FIBER` |
| 98 | COMPNT_INCR_AMT | 1 | 7721 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_INCR_AMT` |
| 99 | INCR_AMT_BLUEMARBLE | 1 | 7722 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_INCR_AMT_BLUEMARBLE` |
| 100 | INCR_AMT_ENS | 1 | 7723 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_INCR_AMT_ENS` |
| 101 | AMT_ENS_MM | 1 | 7724 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_INCR_AMT_ENS_MM` |
| 102 | AMT_SALESFORCE_FIBER | 1 | 7725 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_INCR_AMT_SALESFORCE_FIBER` |
| 103 | PRODUCT_COMPNT_PRICE | 1 | 7726 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_PRICE` |
| 104 | COMPNT_PRICE_BLUEMARBLE | 1 | 7727 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_PRICE_BLUEMARBLE` |
| 105 | COMPNT_PRICE_ENS | 1 | 7728 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_PRICE_ENS` |
| 106 | PRICE_ENS_MM | 1 | 7729 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_PRICE_ENS_MM` |
| 107 | PRICE_SALESFORCE_FIBER | 1 | 7730 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_COMPNT_PRICE_SALESFORCE_FIBER` |
| 108 | PRODUCT_ELEMENT_COST | 1 | 7731 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_ELEMENT_COST` |
| 109 | ELEMENT_COST_BLUEMARBLE | 1 | 7732 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_ELEMENT_COST_BLUEMARBLE` |
| 110 | ELEMENT_COST_ENS | 1 | 7733 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_ELEMENT_COST_ENS` |
| 111 | COST_ENS_MM | 1 | 7734 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_ELEMENT_COST_ENS_MM` |
| 112 | COST_SALESFORCE_FIBER | 1 | 7735 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_ELEMENT_COST_SALESFORCE_FIBER` |
| 113 | NBR_PRODUCT_LOCATION | 1 | 7736 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_LOCATION` |
| 114 | PRODUCT_LOCATION_BLUEMARBLE | 1 | 7737 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_LOCATION_BLUEMARBLE` |
| 115 | PRODUCT_LOCATION_ENS | 1 | 7738 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_LOCATION_ENS` |
| 116 | LOCATION_ENS_MM | 1 | 7739 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_LOCATION_ENS_MM` |
| 117 | LOCATION_SALESFORCE_FIBER | 1 | 7740 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PRODUCT_LOCATION_SALESFORCE_FIBER` |
| 118 | NBR_SALES_REPRESENTATIVE | 1 | 7742 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_SALES_REPRESENTATIVE` |
| 119 | NBR_SOURCE_CONTACT | 1 | 7743 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_SOURCE_CONTACT` |
| 120 | SOURCE_CONTACT_ROLE | 1 | 7744 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_SOURCE_CONTACT_ROLE` |
| 121 | NBR_ULTIMATE_CUSTOMER | 1 | 7750 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_ULTIMATE_CUSTOMER` |

#### DG_7 — 66 members
- **Sources:** `DUMMY_SRCE`
- **Targets:** `DUMMY_TGT1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ARM_CIRCUIT_ALL | 1 | 175 | 5 | `s_m_Check_App_Control_Status_ARM_CIRCUIT_ALL` |
| 2 | ARM_EQUIPMENT_ALL | 1 | 176 | 5 | `s_m_Check_App_Control_Status_ARM_EQUIPMENT_ALL` |
| 3 | Status_ASL_CCSS | 1 | 200 | 4 | `s_m_Check_App_Control_Status_ASL_CCSS` |
| 4 | Status_ASL_CONVERSATIONDETAILJOB | 1 | 206 | 4 | `s_m_Check_App_Control_Status_ASL_CONVERSATIONDETAILJOB` |
| 5 | ASL_CONVERSATION_30Min | 1 | 207 | 4 | `s_m_Check_App_Control_Status_ASL_CONVERSATION_30Min` |
| 6 | Status_ASL_DIVISION | 1 | 214 | 4 | `s_m_Check_App_Control_Status_ASL_DIVISION` |
| 7 | ASL_GENCLOUDATTRIBUTES_PLAID | 1 | 224 | 4 | `s_m_Check_App_Control_Status_ASL_GENCLOUDATTRIBUTES_PLAID` |
| 8 | Status_ASL_GROUPS | 1 | 226 | 4 | `s_m_Check_App_Control_Status_ASL_GROUPS` |
| 9 | ASL_GROUP_USERS | 1 | 227 | 4 | `s_m_Check_App_Control_Status_ASL_GROUP_USERS` |
| 10 | ASL_PARTICIPANT_ATTR | 1 | 249 | 4 | `s_m_Check_App_Control_Status_ASL_PARTICIPANT_ATTR` |
| 11 | Status_ASL_PRESENCE | 1 | 254 | 4 | `s_m_Check_App_Control_Status_ASL_PRESENCE` |
| 12 | Status_ASL_QUEUE | 1 | 260 | 4 | `s_m_Check_App_Control_Status_ASL_QUEUE` |
| 13 | ASL_QUEUE_USER | 1 | 261 | 4 | `s_m_Check_App_Control_Status_ASL_QUEUE_USER` |
| 14 | ASL_SFDC_CTL | 1 | 274 | 4 | `s_m_Check_App_Control_Status_ASL_SFDC_CTL` |
| 15 | Status_ASL_SYSDATE | 1 | 293 | 4 | `s_m_Check_App_Control_Status_ASL_SYSDATE` |
| 16 | Status_ASL_USERS | 1 | 294 | 4 | `s_m_Check_App_Control_Status_ASL_USERS` |
| 17 | ASL_USER_PRESENCE | 1 | 295 | 4 | `s_m_Check_App_Control_Status_ASL_USER_PRESENCE` |
| 18 | ASL_USER_ROUTING | 1 | 296 | 4 | `s_m_Check_App_Control_Status_ASL_USER_ROUTING` |
| 19 | ASL_USER_SKILL | 1 | 297 | 4 | `s_m_Check_App_Control_Status_ASL_USER_SKILL` |
| 20 | ASL_ASSET_SYSDATE | 1 | 319 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_ASSET_SYSDATE` |
| 21 | ASL_CRIS_USECASE11 | 1 | 325 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_CRIS_USECASE11` |
| 22 | MM_UC3_GRP9 | 1 | 328 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_ENS_MM_UC3_GRP9` |
| 23 | ENS_STG_WAVE1 | 1 | 329 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_ENS_STG_WAVE1` |
| 24 | ENS_UC3_GRP5 | 1 | 330 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_ENS_UC3_GRP5` |
| 25 | ENS_UC3_GRP6 | 1 | 331 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_ENS_UC3_GRP6` |
| 26 | ENS_UC3_GRP9 | 1 | 332 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_ENS_UC3_GRP9` |
| 27 | ENS_UC5_GRP1 | 1 | 333 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_ENS_UC5_GRP1` |
| 28 | ENS_UCTRIG_GRP1 | 1 | 334 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_ENS_UCTRIG_GRP1` |
| 29 | ENS_UCTRIG_GRP2 | 1 | 335 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_ENS_UCTRIG_GRP2` |
| 30 | CDW_ASL_COMMON | 1 | 351 | 4 | `s_m_Check_App_Control_Status_CDW_ASL_COMMON` |
| 31 | CODS_BILLING_ACCOUNT | 1 | 361 | 4 | `s_m_Check_App_Control_Status_CODS_BILLING_ACCOUNT` |
| 32 | Status_CODS_CUSTOMER | 1 | 363 | 4 | `s_m_Check_App_Control_Status_CODS_CUSTOMER` |
| 33 | CODS_CUSTOMER_ATTRIBUTION | 1 | 364 | 4 | `s_m_Check_App_Control_Status_CODS_CUSTOMER_ATTRIBUTION` |
| 34 | GCR_HOURLY_Completion | 1 | 371 | 5 | `s_m_Check_App_Control_Status_CRPL_GCR_HOURLY_Completion` |
| 35 | DATAMKTP_BILLING_TICKETS | 1 | 382 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_BILLING_TICKETS` |
| 36 | DATAMKTP_BILLING_TICKETS2 | 1 | 383 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_BILLING_TICKETS2` |
| 37 | Status_DATAMKTP_CUSTOMER | 1 | 384 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_CUSTOMER` |
| 38 | Status_DATAMKTP_CUSTOMER2 | 1 | 385 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_CUSTOMER2` |
| 39 | DATAMKTP_CUSTOMER_BAN | 1 | 386 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_CUSTOMER_BAN` |
| 40 | DATAMKTP_CUSTOMER_BAN2 | 1 | 387 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_CUSTOMER_BAN2` |
| 41 | DATAMKTP_NETWORK_OUTAGES | 1 | 388 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_NETWORK_OUTAGES` |
| 42 | DATAMKTP_NETWORK_OUTAGES2 | 1 | 389 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_NETWORK_OUTAGES2` |
| 43 | Status_DATAMKTP_NPS | 1 | 390 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_NPS` |
| 44 | Status_DATAMKTP_NPS2 | 1 | 391 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_NPS2` |
| 45 | Status_DATAMKTP_ORDERS | 1 | 392 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_ORDERS` |
| 46 | Status_DATAMKTP_ORDERS2 | 1 | 393 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_ORDERS2` |
| 47 | PAST_DUE_INVOICES | 1 | 394 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_PAST_DUE_INVOICES` |
| 48 | PAST_DUE_INVOICES2 | 1 | 395 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_PAST_DUE_INVOICES2` |
| 49 | Status_DATAMKTP_REVENUE | 1 | 396 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_REVENUE` |
| 50 | Status_DATAMKTP_REVENUE2 | 1 | 397 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_REVENUE2` |
| 51 | DATAMKTP_TROUBLE_TICKETS | 1 | 398 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_TROUBLE_TICKETS` |
| 52 | DATAMKTP_TROUBLE_TICKETS2 | 1 | 399 | 4 | `s_m_Check_App_Control_Status_DATAMKTP_TROUBLE_TICKETS2` |
| 53 | Status_DSL_FINANCE | 1 | 404 | 4 | `s_m_Check_App_Control_Status_DSL_FINANCE` |
| 54 | Status_DWOPS_CNTRLM | 1 | 409 | 5 | `s_m_Check_App_Control_Status_DWOPS_CNTRLM` |
| 55 | Status_DWPROD_CTL | 1 | 410 | 5 | `s_m_Check_App_Control_Status_DWPROD_CTL` |
| 56 | LIMS_CIRCUIT_ALL | 1 | 437 | 5 | `s_m_Check_App_Control_Status_LIMS_CIRCUIT_ALL` |
| 57 | LIMS_EQUIPMENT_ALL | 1 | 438 | 5 | `s_m_Check_App_Control_Status_LIMS_EQUIPMENT_ALL` |
| 58 | Status_LOCATION_GLM | 1 | 440 | 5 | `s_m_Check_App_Control_Status_LOCATION_GLM` |
| 59 | Status_ODS_ORDER | 1 | 460 | 4 | `s_m_Check_App_Control_Status_ODS_ORDER` |
| 60 | ORDER_EASE_CABS | 1 | 462 | 4 | `s_m_Check_App_Control_Status_ODS_ORDER_EASE_CABS` |
| 61 | SOURCE_CONTACT_4HR | 1 | 465 | 4 | `s_m_Check_App_Control_Status_ODS_SOURCE_CONTACT_4HR` |
| 62 | Control_Status_PRIME | 1 | 478 | 5 | `s_m_Check_App_Control_Status_PRIME` |
| 63 | SFDC_CTL_ACCOUNT | 1 | 495 | 4 | `s_m_Check_App_Control_Status_SFDC_CTL_ACCOUNT` |
| 64 | Control_Status_SPEEDWARE | 1 | 505 | 4 | `s_m_Check_App_Control_Status_SPEEDWARE` |
| 65 | LOCATION_ALL_ARM | 1 | 1529 | 5 | `s_m_Load_CHECK_APP_CONTROL_STATUS_LOCATION_ALL_ARM` |
| 66 | LOCATION_ALL_LIMS | 1 | 1530 | 5 | `s_m_Load_CHECK_APP_CONTROL_STATUS_LOCATION_ALL_LIMS` |

#### DG_8 — 51 members
- **Sources:** `DUMMY_SRC`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BM_STATS_GATHER | 1 | 35 | 1 | `s_m_ASL_BM_STATS_GATHER` |
| 2 | BM_STATS_GATHER | 1 | 36 | 1 | `s_m_ASL_CONSOL_BM_STATS_GATHER` |
| 3 | Status_Prior_IPCIIT | 1 | 142 | 5 | `s_m_Check_ASL_Status_Prior_IPCIIT` |
| 4 | API_SECURITY_AUDIT | 1 | 559 | 4 | `s_m_Check_Readyness_of_API_SECURITY_AUDIT` |
| 5 | USECASE5_STATS_CDL | 1 | 567 | 3 | `s_m_Compute_CA2PD_USECASE5_STATS_CDL` |
| 6 | Incr_Stats_CDL | 1 | 568 | 3 | `s_m_Compute_CRIS_Incr_Stats_CDL` |
| 7 | Compute_Stats_CDL | 1 | 569 | 3 | `s_m_Compute_Stats_CDL` |
| 8 | CDL_ASL_CCSS | 1 | 570 | 3 | `s_m_Compute_Stats_CDL_ASL_CCSS` |
| 9 | PROD_ORDER_STG | 1 | 571 | 3 | `s_m_Compute_Stats_CDL_PROD_ORDER_STG` |
| 10 | Stats_CDL_STG | 1 | 572 | 3 | `s_m_Compute_Stats_CDL_STG` |
| 11 | CDL_STG_LKP | 1 | 573 | 3 | `s_m_Compute_Stats_CDL_STG_LKP` |
| 12 | to_LATAM_scp | 1 | 611 | 1 | `s_m_Dummy_to_LATAM_scp` |
| 13 | STG_ATTR_LKP | 1 | 1514 | 3 | `s_m_Load_CHARGE_STG_ATTR_LKP` |
| 14 | STG_SDP_LKP | 1 | 1517 | 3 | `s_m_Load_CHARGE_STG_SDP_LKP` |
| 15 | STG_INSTALL_DT | 1 | 1561 | 3 | `s_m_Load_CIRCUIT_ASSET_STG_INSTALL_DT` |
| 16 | ENG_REC_LKP | 1 | 1574 | 3 | `s_m_Load_CIRCUIT_ORDER_STG_ENG_REC_LKP` |
| 17 | STG_HIST_LKP | 1 | 1576 | 3 | `s_m_Load_CIRCUIT_ORDER_STG_HIST_LKP` |
| 18 | STG_Historical_TMP | 1 | 1578 | 3 | `s_m_Load_CIRCUIT_ORDER_STG_Historical_TMP` |
| 19 | STG_NonHistorical_TMP | 1 | 1579 | 3 | `s_m_Load_CIRCUIT_ORDER_STG_NonHistorical_TMP` |
| 20 | STG_PRIORITY_LKP | 1 | 1581 | 3 | `s_m_Load_CIRCUIT_ORDER_STG_PRIORITY_LKP` |
| 21 | ID_800_LKP | 1 | 1584 | 3 | `s_m_Load_CIRCUIT_ORDER_STG_SALES_ORDER_ID_800_LKP` |
| 22 | Load_COB_STG | 1 | 1653 | 3 | `s_m_Load_COB_STG` |
| 23 | 7YO_ACTIVE_ORDERS | 1 | 1654 | 3 | `s_m_Load_COB_STG_HIST_7YO_ACTIVE_ORDERS` |
| 24 | HIST_7YO_TMP | 1 | 1655 | 3 | `s_m_Load_COB_STG_HIST_7YO_TMP` |
| 25 | HIST_7YO_TMP1 | 1 | 1656 | 3 | `s_m_Load_COB_STG_HIST_7YO_TMP1` |
| 26 | HIST_7YO_TMP2 | 1 | 1657 | 3 | `s_m_Load_COB_STG_HIST_7YO_TMP2` |
| 27 | HIST_7YO_TMP3 | 1 | 1658 | 3 | `s_m_Load_COB_STG_HIST_7YO_TMP3` |
| 28 | HIST_7YO_TMP4 | 1 | 1659 | 3 | `s_m_Load_COB_STG_HIST_7YO_TMP4` |
| 29 | HIST_7YO_TMP5 | 1 | 1660 | 3 | `s_m_Load_COB_STG_HIST_7YO_TMP5` |
| 30 | STG_HIST_TMP | 1 | 1661 | 3 | `s_m_Load_COB_STG_HIST_TMP` |
| 31 | STG_HIST_TMP1 | 1 | 1662 | 3 | `s_m_Load_COB_STG_HIST_TMP1` |
| 32 | STG_HIST_TMP2 | 1 | 1663 | 3 | `s_m_Load_COB_STG_HIST_TMP2` |
| 33 | STG_HIST_TMP3 | 1 | 1664 | 3 | `s_m_Load_COB_STG_HIST_TMP3` |
| 34 | STG_HIST_TMP4 | 1 | 1665 | 3 | `s_m_Load_COB_STG_HIST_TMP4` |
| 35 | STG_HIST_TMP5 | 1 | 1666 | 3 | `s_m_Load_COB_STG_HIST_TMP5` |
| 36 | COP_CCD_LKP | 1 | 1780 | 3 | `s_m_Load_COP_CCD_LKP` |
| 37 | COP_DATES_LKP | 1 | 1782 | 3 | `s_m_Load_COP_DATES_LKP` |
| 38 | COP_LKP_Tables | 1 | 1784 | 3 | `s_m_Load_COP_LKP_Tables` |
| 39 | COP_SUBTYP_LKP | 1 | 1785 | 3 | `s_m_Load_COP_SUBTYP_LKP` |
| 40 | VOICE_ACCES_LKP | 1 | 1787 | 3 | `s_m_Load_COP_VOICE_ACCES_LKP` |
| 41 | COP_WKFL_LKP | 1 | 1789 | 3 | `s_m_Load_COP_WKFL_LKP` |
| 42 | Load_Dummy | 1 | 2440 | 2 | `s_m_Load_Dummy` |
| 43 | Dummy_Transfer_Files | 1 | 2441 | 2 | `s_m_Load_Dummy_Transfer_Files` |
| 44 | BM_STATS_GATHER | 1 | 4765 | 1 | `s_m_Load_RPL_BM_STATS_GATHER` |
| 45 | ATTR_PRICEALGTYP_LKP | 1 | 4899 | 3 | `s_m_Load_SDP_COP_ATTR_PRICEALGTYP_LKP` |
| 46 | ORDER_STATUS_LKP | 1 | 4900 | 3 | `s_m_Load_SDP_COP_ORDER_STATUS_LKP` |
| 47 | ORDER_HIST_LKP | 1 | 4901 | 3 | `s_m_Load_SDP_EIS_ORDER_HIST_LKP` |
| 48 | ACT_TYP_STG | 1 | 4990 | 3 | `s_m_Load_SERV_ORD_ACT_TYP_STG` |
| 49 | STG_Tables_CAS | 1 | 5323 | 3 | `s_m_Load_STG_Tables_CAS` |
| 50 | CDRW_from_HDFS | 1 | 6857 | 3 | `s_m_Unload_CDRW_from_HDFS` |
| 51 | PRODUCT_COMPNT_LKP | 1 | 7027 | 3 | `s_m_Update_PROD_ORDER_PRODUCT_COMPNT_LKP` |

#### DG_9 — 50 members
- **Sources:** `DUMMY_NBR_SRC`
- **Targets:** `FF_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORAFIN_BDGT_INSERT | 1 | 3212 | 3 | `s_m_Load_JOURNAL_LINE_AMT_ORAFIN_BDGT_INSERT` |
| 2 | ORAFIN_BDGT_UPDATE | 1 | 3213 | 3 | `s_m_Load_JOURNAL_LINE_AMT_ORAFIN_BDGT_UPDATE` |
| 3 | ORAFIN_DAILY_INSERT | 1 | 3214 | 3 | `s_m_Load_JOURNAL_LINE_AMT_ORAFIN_DAILY_INSERT` |
| 4 | ORAFIN_DAILY_UPDATE | 1 | 3215 | 3 | `s_m_Load_JOURNAL_LINE_AMT_ORAFIN_DAILY_UPDATE` |
| 5 | ORAFIN_USD_INSERT | 1 | 3216 | 3 | `s_m_Load_JOURNAL_LINE_AMT_ORAFIN_USD_INSERT` |
| 6 | ORAFIN_USD_UPDATE | 1 | 3217 | 3 | `s_m_Load_JOURNAL_LINE_AMT_ORAFIN_USD_UPDATE` |
| 7 | AMT_SAP_INSERT | 1 | 3218 | 3 | `s_m_Load_JOURNAL_LINE_AMT_SAP_INSERT` |
| 8 | AMT_SAP_UPDATE | 1 | 3219 | 3 | `s_m_Load_JOURNAL_LINE_AMT_SAP_UPDATE` |
| 9 | JOURNAL_LINE_INSERT | 1 | 3223 | 3 | `s_m_Load_JOURNAL_LINE_INSERT` |
| 10 | JOURNAL_LINE_UPDATE | 1 | 3225 | 3 | `s_m_Load_JOURNAL_LINE_UPDATE` |
| 11 | MARGIN_MONTH_CONTROL | 1 | 3434 | 4 | `s_m_Load_MARGIN_MONTH_CONTROL` |
| 12 | EBS_ERT_CDW | 1 | 5412 | 5 | `s_m_Load_SWP_ALL_RECON_EBS_ERT_CDW` |
| 13 | Load_TMP_ACCRUAL | 1 | 6090 | 4 | `s_m_Load_TMP_ACCRUAL` |
| 14 | TMP_ALLOC_REV | 1 | 6091 | 4 | `s_m_Load_TMP_ALLOC_REV` |
| 15 | EBS_ORAFIN_DIFF | 1 | 6092 | 3 | `s_m_Load_TMP_ALL_EBS_ORAFIN_DIFF` |
| 16 | EBS_GOAT_CDW | 1 | 6094 | 5 | `s_m_Load_TMP_ALL_RECON_EBS_GOAT_CDW` |
| 17 | BPC_RELATED_ORDERS | 1 | 6095 | 4 | `s_m_Load_TMP_BPC_RELATED_ORDERS` |
| 18 | TMP_BUNDLE_REV | 1 | 6096 | 4 | `s_m_Load_TMP_BUNDLE_REV` |
| 19 | BUNDLE_REV_COUNT | 1 | 6097 | 4 | `s_m_Load_TMP_BUNDLE_REV_COUNT` |
| 20 | TMP_CODE_COMBOS | 1 | 6098 | 4 | `s_m_Load_TMP_CODE_COMBOS` |
| 21 | TMP_CONV_SERVICE | 1 | 6099 | 4 | `s_m_Load_TMP_CONV_SERVICE` |
| 22 | CPO_SCID_MCHG | 1 | 6100 | 4 | `s_m_Load_TMP_CPO_SCID_MCHG` |
| 23 | DER_PIID_VIEW | 1 | 6101 | 4 | `s_m_Load_TMP_DER_PIID_VIEW` |
| 24 | Load_TMP_FRDA | 1 | 6104 | 4 | `s_m_Load_TMP_FRDA` |
| 25 | FRD_AMT_DATES | 1 | 6107 | 3 | `s_m_Load_TMP_FRD_AMT_DATES` |
| 26 | TGT_AS_SRC | 1 | 6113 | 4 | `s_m_Load_TMP_FRD_AMT_TGT_AS_SRC` |
| 27 | FRD_AMT_UNION | 1 | 6114 | 3 | `s_m_Load_TMP_FRD_AMT_UNION` |
| 28 | GL_SEGMENTS_ALL | 1 | 6115 | 3 | `s_m_Load_TMP_GL_SEGMENTS_ALL` |
| 29 | EBS_GOAT_FRS | 1 | 6116 | 5 | `s_m_Load_TMP_RECON_ALL_EBS_GOAT_FRS` |
| 30 | ASL_GL_BALANCE | 1 | 6117 | 4 | `s_m_Load_TMP_RECON_ASL_GL_BALANCE` |
| 31 | GL_BALANCE_ID | 1 | 6118 | 4 | `s_m_Load_TMP_RECON_ASL_GL_BALANCE_ID` |
| 32 | GL_BALANCE_INDEX | 1 | 6119 | 4 | `s_m_Load_TMP_RECON_ASL_GL_BALANCE_INDEX` |
| 33 | BALANCE_NON_INDEX | 1 | 6120 | 4 | `s_m_Load_TMP_RECON_ASL_GL_BALANCE_NON_INDEX` |
| 34 | EBS_GOAT_FRS | 1 | 6122 | 5 | `s_m_Load_TMP_RECON_REV_EBS_GOAT_FRS` |
| 35 | ORAFIN_FRD_GOAT | 1 | 6123 | 5 | `s_m_Load_TMP_RECON_REV_EBS_ORAFIN_FRD_GOAT` |
| 36 | SAP_GL_BALANCE | 1 | 6124 | 4 | `s_m_Load_TMP_RECON_SAP_GL_BALANCE` |
| 37 | GL_BALANCE_INDEX | 1 | 6126 | 4 | `s_m_Load_TMP_RECON_SAP_GL_BALANCE_INDEX` |
| 38 | BALANCE_NON_INDEX | 1 | 6127 | 4 | `s_m_Load_TMP_RECON_SAP_GL_BALANCE_NON_INDEX` |
| 39 | TMP_RELATED_ORDER | 1 | 6128 | 4 | `s_m_Load_TMP_RELATED_ORDER` |
| 40 | RELATED_ORDER_SEM | 1 | 6129 | 4 | `s_m_Load_TMP_RELATED_ORDER_SEM` |
| 41 | EBS_ORAFIN_DIFF | 1 | 6130 | 3 | `s_m_Load_TMP_REV_EBS_ORAFIN_DIFF` |
| 42 | TMP_REV_PIID | 1 | 6132 | 4 | `s_m_Load_TMP_REV_PIID` |
| 43 | REV_PIID_BPC | 1 | 6133 | 6 | `s_m_Load_TMP_REV_PIID_BPC` |
| 44 | REV_PIID_COUNT | 1 | 6134 | 4 | `s_m_Load_TMP_REV_PIID_COUNT` |
| 45 | REV_PIID_ONNET | 1 | 6135 | 4 | `s_m_Load_TMP_REV_PIID_ONNET` |
| 46 | SAP_GL_BALANCE | 1 | 6136 | 4 | `s_m_Load_TMP_SAP_GL_BALANCE` |
| 47 | GL_BALANCE_INDEX | 1 | 6138 | 4 | `s_m_Load_TMP_SAP_GL_BALANCE_INDEX` |
| 48 | BALANCE_NON_INDEX | 1 | 6139 | 4 | `s_m_Load_TMP_SAP_GL_BALANCE_NON_INDEX` |
| 49 | TMP_STARBUCK_PIID | 1 | 6140 | 4 | `s_m_Load_TMP_STARBUCK_PIID` |
| 50 | JOURNAL_LINE_PA | 1 | 6709 | 2 | `s_m_Load_update_JOURNAL_LINE_PA` |

#### DG_10 — 44 members
- **Sources:** `MONTHS_PROCESSED, MONTHS_PROCESSED1`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RETAINED_EARNINGS_RANK1 | 1 | 2936 | 3 | `s_m_Load_F_BALANCE_EXTRACT_CUST_RETAINED_EARNINGS_RANK1` |
| 2 | RETAINED_EARNINGS_RANK2 | 1 | 2937 | 3 | `s_m_Load_F_BALANCE_EXTRACT_CUST_RETAINED_EARNINGS_RANK2` |
| 3 | RETAINED_EARNINGS_RANK3 | 1 | 2938 | 3 | `s_m_Load_F_BALANCE_EXTRACT_CUST_RETAINED_EARNINGS_RANK3` |
| 4 | RETAINED_EARNINGS_RANK4 | 1 | 2939 | 3 | `s_m_Load_F_BALANCE_EXTRACT_CUST_RETAINED_EARNINGS_RANK4` |
| 5 | RETAINED_EARNINGS_RANK5 | 1 | 2940 | 3 | `s_m_Load_F_BALANCE_EXTRACT_CUST_RETAINED_EARNINGS_RANK5` |
| 6 | RETAINED_EARNINGS_RANK6 | 1 | 2941 | 3 | `s_m_Load_F_BALANCE_EXTRACT_CUST_RETAINED_EARNINGS_RANK6` |
| 7 | RETAINED_EARNINGS_RANK1 | 1 | 2942 | 3 | `s_m_Load_F_BALANCE_EXTRACT_RETAINED_EARNINGS_RANK1` |
| 8 | RETAINED_EARNINGS_RANK2 | 1 | 2943 | 3 | `s_m_Load_F_BALANCE_EXTRACT_RETAINED_EARNINGS_RANK2` |
| 9 | RETAINED_EARNINGS_RANK3 | 1 | 2944 | 3 | `s_m_Load_F_BALANCE_EXTRACT_RETAINED_EARNINGS_RANK3` |
| 10 | RETAINED_EARNINGS_RANK4 | 1 | 2945 | 3 | `s_m_Load_F_BALANCE_EXTRACT_RETAINED_EARNINGS_RANK4` |
| 11 | RETAINED_EARNINGS_RANK5 | 1 | 2946 | 3 | `s_m_Load_F_BALANCE_EXTRACT_RETAINED_EARNINGS_RANK5` |
| 12 | RETAINED_EARNINGS_RANK6 | 1 | 2947 | 3 | `s_m_Load_F_BALANCE_EXTRACT_RETAINED_EARNINGS_RANK6` |
| 13 | RETAINED_EARNINGS_RANK1 | 1 | 2960 | 3 | `s_m_Load_F_PRT_EXTRACT_RETAINED_EARNINGS_RANK1` |
| 14 | RETAINED_EARNINGS_RANK2 | 1 | 2961 | 3 | `s_m_Load_F_PRT_EXTRACT_RETAINED_EARNINGS_RANK2` |
| 15 | RETAINED_EARNINGS_RANK3 | 1 | 2962 | 3 | `s_m_Load_F_PRT_EXTRACT_RETAINED_EARNINGS_RANK3` |
| 16 | RETAINED_EARNINGS_RANK4 | 1 | 2963 | 3 | `s_m_Load_F_PRT_EXTRACT_RETAINED_EARNINGS_RANK4` |
| 17 | RETAINED_EARNINGS_RANK5 | 1 | 2964 | 3 | `s_m_Load_F_PRT_EXTRACT_RETAINED_EARNINGS_RANK5` |
| 18 | RETAINED_EARNINGS_RANK6 | 1 | 2965 | 3 | `s_m_Load_F_PRT_EXTRACT_RETAINED_EARNINGS_RANK6` |
| 19 | EXTRACT_CUST_RANK1 | 1 | 5419 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_CUST_RANK1` |
| 20 | EXTRACT_CUST_RANK2 | 1 | 5420 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_CUST_RANK2` |
| 21 | EXTRACT_CUST_RANK3 | 1 | 5421 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_CUST_RANK3` |
| 22 | EXTRACT_CUST_RANK4 | 1 | 5422 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_CUST_RANK4` |
| 23 | EXTRACT_CUST_RANK5 | 1 | 5423 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_CUST_RANK5` |
| 24 | EXTRACT_CUST_RANK6 | 1 | 5424 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_CUST_RANK6` |
| 25 | BALANCE_EXTRACT_RANK1 | 1 | 5439 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_RANK1` |
| 26 | BALANCE_EXTRACT_RANK2 | 1 | 5440 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_RANK2` |
| 27 | BALANCE_EXTRACT_RANK3 | 1 | 5441 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_RANK3` |
| 28 | BALANCE_EXTRACT_RANK4 | 1 | 5442 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_RANK4` |
| 29 | BALANCE_EXTRACT_RANK5 | 1 | 5443 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_RANK5` |
| 30 | BALANCE_EXTRACT_RANK6 | 1 | 5444 | 13 | `s_m_Load_SWP_F_BALANCE_EXTRACT_RANK6` |
| 31 | F_JOURNAL_DETAIL | 1 | 5466 | 13 | `s_m_Load_SWP_F_JOURNAL_DETAIL` |
| 32 | JOURNAL_DETAIL_RANK1 | 1 | 5467 | 13 | `s_m_Load_SWP_F_JOURNAL_DETAIL_RANK1` |
| 33 | JOURNAL_DETAIL_RANK2 | 1 | 5468 | 13 | `s_m_Load_SWP_F_JOURNAL_DETAIL_RANK2` |
| 34 | JOURNAL_DETAIL_RANK3 | 1 | 5469 | 13 | `s_m_Load_SWP_F_JOURNAL_DETAIL_RANK3` |
| 35 | JOURNAL_DETAIL_RANK4 | 1 | 5470 | 13 | `s_m_Load_SWP_F_JOURNAL_DETAIL_RANK4` |
| 36 | JOURNAL_DETAIL_RANK5 | 1 | 5471 | 13 | `s_m_Load_SWP_F_JOURNAL_DETAIL_RANK5` |
| 37 | JOURNAL_DETAIL_RANK6 | 1 | 5472 | 13 | `s_m_Load_SWP_F_JOURNAL_DETAIL_RANK6` |
| 38 | F_PRT_EXTRACT | 1 | 5499 | 13 | `s_m_Load_SWP_F_PRT_EXTRACT` |
| 39 | PRT_EXTRACT_RANK1 | 1 | 5500 | 13 | `s_m_Load_SWP_F_PRT_EXTRACT_RANK1` |
| 40 | PRT_EXTRACT_RANK2 | 1 | 5501 | 13 | `s_m_Load_SWP_F_PRT_EXTRACT_RANK2` |
| 41 | PRT_EXTRACT_RANK3 | 1 | 5502 | 13 | `s_m_Load_SWP_F_PRT_EXTRACT_RANK3` |
| 42 | PRT_EXTRACT_RANK4 | 1 | 5503 | 13 | `s_m_Load_SWP_F_PRT_EXTRACT_RANK4` |
| 43 | PRT_EXTRACT_RANK5 | 1 | 5504 | 13 | `s_m_Load_SWP_F_PRT_EXTRACT_RANK5` |
| 44 | PRT_EXTRACT_RANK6 | 1 | 5505 | 13 | `s_m_Load_SWP_F_PRT_EXTRACT_RANK6` |

#### DG_11 — 36 members
- **Sources:** `DUAL`
- **Targets:** `DUAL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ACCESS_GRP_95PCT | 1 | 45 | 2 | `s_m_CACHING_ACCESS_GRP_95PCT` |
| 2 | CACHING_BILLING_YESTERDAY | 1 | 46 | 2 | `s_m_CACHING_BILLING_YESTERDAY` |
| 3 | CACHING_DISTRIBUTOR_REROLL | 1 | 47 | 2 | `s_m_CACHING_DISTRIBUTOR_REROLL` |
| 4 | CACHING_DISTRIBUTOR_ROLLUP | 1 | 48 | 2 | `s_m_CACHING_DISTRIBUTOR_ROLLUP` |
| 5 | CACHING_DIST_DSL | 1 | 49 | 2 | `s_m_CACHING_DIST_DSL` |
| 6 | DIST_DSL_BILLING | 1 | 50 | 2 | `s_m_CACHING_DIST_DSL_BILLING` |
| 7 | DIST_ROLLUP_HOURLY | 1 | 51 | 2 | `s_m_CACHING_DIST_ROLLUP_HOURLY` |
| 8 | CACHING_PEAK | 1 | 52 | 2 | `s_m_CACHING_PEAK` |
| 9 | CACHING_REROLL | 1 | 53 | 2 | `s_m_CACHING_REROLL` |
| 10 | CACHING_REROLL_BILLING | 1 | 54 | 2 | `s_m_CACHING_REROLL_BILLING` |
| 11 | CACHING_ROLLUP_TODAY | 1 | 55 | 2 | `s_m_CACHING_ROLLUP_TODAY` |
| 12 | CACHING_ROLLUP_YESTERDAY | 1 | 56 | 2 | `s_m_CACHING_ROLLUP_YESTERDAY` |
| 13 | CACHING_SCID_DSL | 1 | 57 | 2 | `s_m_CACHING_SCID_DSL` |
| 14 | SCID_DSL_BILLING | 1 | 58 | 2 | `s_m_CACHING_SCID_DSL_BILLING` |
| 15 | CDN_BILLING | 1 | 119 | 2 | `s_m_CDN_BILLING` |
| 16 | ONLY_RLLP_TABLES | 1 | 667 | 5 | `s_m_LOAD_ACCG_ONLY_RLLP_TABLES` |
| 17 | ROLLUP_CACH_PROP | 1 | 699 | 3 | `s_m_LOAD_AUTO_ROLLUP_CACH_PROP` |
| 18 | CACHING_DISTRIBUTOR_RLLP | 1 | 711 | 2 | `s_m_LOAD_DSL_CACHING_DISTRIBUTOR_RLLP` |
| 19 | CACH_5MIN_RLLP | 1 | 712 | 2 | `s_m_LOAD_DSL_CACH_5MIN_RLLP` |
| 20 | CACH_SCID_METRO | 1 | 713 | 2 | `s_m_LOAD_DSL_CACH_SCID_METRO` |
| 21 | CACH_SCID_REGION | 1 | 714 | 2 | `s_m_LOAD_DSL_CACH_SCID_REGION` |
| 22 | DSL_TAB_ANALYZE | 1 | 715 | 17 | `s_m_LOAD_DSL_TAB_ANALYZE` |
| 23 | BILL_AGGR_FINAL | 1 | 778 | 4 | `s_m_LOAD_MONTHLY_BILL_AGGR_FINAL` |
| 24 | VHOST_DAILY_MV1 | 1 | 785 | 3 | `s_m_LOAD_ORGSTG_VHOST_DAILY_MV1` |
| 25 | TABLES_DAILY_OPTIMIZED | 1 | 794 | 3 | `s_m_LOAD_ROLLUP_T_TABLES_DAILY_OPTIMIZED` |
| 26 | 95PCT_STRSUMM_ACG | 1 | 832 | 5 | `s_m_LOAD_UPDT_95PCT_STRSUMM_ACG` |
| 27 | USG_BILLING_TBL | 1 | 833 | 2 | `s_m_LOAD_UPD_USG_BILLING_TBL` |
| 28 | USG_BILLING_TBL1 | 1 | 834 | 2 | `s_m_LOAD_UPD_USG_BILLING_TBL1` |
| 29 | USG_BILLING_TBL2 | 1 | 835 | 2 | `s_m_LOAD_UPD_USG_BILLING_TBL2` |
| 30 | MP_CACHING_DSL | 1 | 6723 | 2 | `s_m_MP_CACHING_DSL` |
| 31 | CACHING_MBPS_95PCT | 1 | 6724 | 2 | `s_m_MP_CACHING_MBPS_95PCT` |
| 32 | MP_CACHING_PEAK | 1 | 6725 | 2 | `s_m_MP_CACHING_PEAK` |
| 33 | CACHING_PEAK_BILLING | 1 | 6726 | 2 | `s_m_MP_CACHING_PEAK_BILLING` |
| 34 | 5MIN_TENCENT_CACHING | 1 | 6753 | 2 | `s_m_RLUP_5MIN_TENCENT_CACHING` |
| 35 | STAGE_TAB_OPTIMISED | 1 | 6824 | 2 | `s_m_TRUNCATE_AL_STAGE_TAB_OPTIMISED` |
| 36 | dummy | 1 | 7215 | 2 | `s_m_dummy` |

#### DG_12 — 35 members
- **Sources:** `PROCESS_PARAMETER`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_ID_SAP | 16 | 10273 | 3 | `s_m_Check_Load_ID_SAP` |
| 2 | GLB_GLB_DIFF | 16 | 10391 | 4 | `s_m_Load_RECON_ASL_GLB_GLB_DIFF` |
| 3 | ESS_GOATCTL_SUM | 16 | 10392 | 5 | `s_m_Load_RECON_ESS_GOATCTL_SUM` |
| 4 | FBE_GOATCTL_DIFF | 16 | 10393 | 4 | `s_m_Load_RECON_FBE_GOATCTL_DIFF` |
| 5 | BALANCE_EXTRACT_SUM | 16 | 10394 | 4 | `s_m_Load_RECON_F_BALANCE_EXTRACT_SUM` |
| 6 | GLB_FBE_DIFF | 16 | 10395 | 4 | `s_m_Load_RECON_GLB_FBE_DIFF` |
| 7 | GL_BALANCE_SUM | 16 | 10397 | 4 | `s_m_Load_RECON_GL_BALANCE_SUM` |
| 8 | GLB_FBE_DIFF | 16 | 10398 | 4 | `s_m_Load_RECON_SAP_GLB_FBE_DIFF` |
| 9 | PROD_PROF_SUM | 16 | 10403 | 5 | `s_m_Load_STG_PROD_PROF_SUM` |
| 10 | ACCOUNT_CURR_MNTH | 16 | 10412 | 7 | `s_m_Load_SWP_DH_BILLING_ACCOUNT_CURR_MNTH` |
| 11 | ACCOUNT_NEXT_MNTH | 16 | 10413 | 7 | `s_m_Load_SWP_DH_BILLING_ACCOUNT_NEXT_MNTH` |
| 12 | ATTR_CURR_MNTH | 16 | 10414 | 6 | `s_m_Load_SWP_DH_BILL_ACCOUNT_ATTR_CURR_MNTH` |
| 13 | ATTR_NEXT_MNTH | 16 | 10415 | 6 | `s_m_Load_SWP_DH_BILL_ACCOUNT_ATTR_NEXT_MNTH` |
| 14 | COMBO_CURR_MNTH | 16 | 10418 | 7 | `s_m_Load_SWP_DH_GL_CODE_COMBO_CURR_MNTH` |
| 15 | COMBO_NEXT_MNTH | 16 | 10419 | 7 | `s_m_Load_SWP_DH_GL_CODE_COMBO_NEXT_MNTH` |
| 16 | COMBO_PREV_MNTH | 16 | 10420 | 7 | `s_m_Load_SWP_DH_GL_CODE_COMBO_PREV_MNTH` |
| 17 | ALL_CURR_MNTH | 16 | 10421 | 7 | `s_m_Load_SWP_DH_GL_SEGMENT_ALL_CURR_MNTH` |
| 18 | ALL_NEXT_MNTH | 16 | 10422 | 7 | `s_m_Load_SWP_DH_GL_SEGMENT_ALL_NEXT_MNTH` |
| 19 | ACCT_CURR_MNTH | 16 | 10423 | 7 | `s_m_Load_SWP_DH_SOURCE_BILL_ACCT_CURR_MNTH` |
| 20 | ACCT_NEXT_MNTH | 16 | 10424 | 7 | `s_m_Load_SWP_DH_SOURCE_BILL_ACCT_NEXT_MNTH` |
| 21 | ALLOC_CURR_MNTH | 16 | 10425 | 3 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_NON_ALLOC_CURR_MNTH` |
| 22 | ALLOC_NEXT_MNTH | 16 | 10426 | 3 | `s_m_Load_SWP_F_BALANCE_EXTRACT_POST_ALLOC_NON_ALLOC_NEXT_MNTH` |
| 23 | ALLOC_CURR_MNTH | 16 | 10427 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_PRE_ALLOC_CURR_MNTH` |
| 24 | ALLOC_NEXT_MNTH | 16 | 10428 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_PRE_ALLOC_NEXT_MNTH` |
| 25 | PARTITION_CURR_MNTH | 16 | 10429 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_PRE_ALLOC_SWAP_PARTITION_CURR_MNTH` |
| 26 | PARTITION_NEXT_MNTH | 16 | 10430 | 4 | `s_m_Load_SWP_F_BALANCE_EXTRACT_PRE_ALLOC_SWAP_PARTITION_NEXT_MNTH` |
| 27 | L3AR_SAP_ORA | 16 | 10435 | 6 | `s_m_Load_SWP_RECON_L3AR_SAP_ORA` |
| 28 | ORA_CURR_MNTH | 16 | 10436 | 6 | `s_m_Load_SWP_RECON_L3AR_SAP_ORA_CURR_MNTH` |
| 29 | ORA_NEXT_MNTH | 16 | 10437 | 6 | `s_m_Load_SWP_RECON_L3AR_SAP_ORA_NEXT_MNTH` |
| 30 | GL_MASTER_XREF | 16 | 10444 | 4 | `s_m_Swap_Partition_DH_LEGACY_GL_MASTER_XREF` |
| 31 | XREF_NEXT_MNTH | 16 | 10445 | 4 | `s_m_Swap_Partition_DH_LEGACY_GL_MASTER_XREF_NEXT_MNTH` |
| 32 | F_BILLING_DETAIL | 16 | 10446 | 4 | `s_m_Swap_Partition_F_BILLING_DETAIL` |
| 33 | DETAIL_CURR_MNTH | 16 | 10447 | 4 | `s_m_Swap_Partition_F_BILLING_DETAIL_CURR_MNTH` |
| 34 | DETAIL_NEXT_MNTH | 16 | 10448 | 4 | `s_m_Swap_Partition_F_BILLING_DETAIL_NEXT_MNTH` |
| 35 | PROF_POST_ALLOC | 16 | 10449 | 4 | `s_m_Swap_Partitions_for_PROD_PROF_POST_ALLOC` |

#### DG_13 — 32 members
- **Sources:** `OMS_ORDER`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ARPU_COS_BASE | 2 | 7957 | 1 | `s_m_Load_ARPU_COS_BASE` |
| 2 | ARPU_RATE_BASE | 2 | 7958 | 1 | `s_m_Load_ARPU_RATE_BASE` |
| 3 | CIRCUIT_ORDER_STG1 | 2 | 7996 | 2 | `s_m_Load_CDL_CIRCUIT_ORDER_STG1` |
| 4 | CIRCUIT_ORDER_STG2 | 2 | 7997 | 2 | `s_m_Load_CDL_CIRCUIT_ORDER_STG2` |
| 5 | CIRCUIT_ORDER_STG3 | 2 | 7998 | 2 | `s_m_Load_CDL_CIRCUIT_ORDER_STG3` |
| 6 | SCB_CHARGE_STG | 2 | 8000 | 2 | `s_m_Load_CDL_RC_SCB_CHARGE_STG` |
| 7 | CIRCUIT_ORDER_STG | 2 | 8001 | 2 | `s_m_Load_CDL_RC_SCB_CIRCUIT_ORDER_STG` |
| 8 | CHARGE_STG_CDL | 2 | 8010 | 2 | `s_m_Load_CHARGE_STG_CDL` |
| 9 | CHARGE_STG_MM | 2 | 8011 | 1 | `s_m_Load_CHARGE_STG_MM` |
| 10 | STG_MM_HIST | 2 | 8012 | 1 | `s_m_Load_CHARGE_STG_MM_HIST` |
| 11 | ORDER_STG1_MM | 2 | 8025 | 1 | `s_m_Load_CIRCUIT_ORDER_STG1_MM` |
| 12 | CIRCUIT_ORDER_STG2 | 2 | 8026 | 1 | `s_m_Load_CIRCUIT_ORDER_STG2` |
| 13 | ORDER_STG2_MM | 2 | 8027 | 1 | `s_m_Load_CIRCUIT_ORDER_STG2_MM` |
| 14 | CIRCUIT_ORDER_STG3 | 2 | 8028 | 1 | `s_m_Load_CIRCUIT_ORDER_STG3` |
| 15 | ORDER_STG3_MM | 2 | 8029 | 1 | `s_m_Load_CIRCUIT_ORDER_STG3_MM` |
| 16 | ORDER_STG_CDL | 2 | 8030 | 2 | `s_m_Load_CIRCUIT_ORDER_STG_CDL` |
| 17 | ORDER_STG_MM | 2 | 8033 | 1 | `s_m_Load_CIRCUIT_ORDER_STG_MM` |
| 18 | STG_MM_HIST | 2 | 8034 | 1 | `s_m_Load_CIRCUIT_ORDER_STG_MM_HIST` |
| 19 | CONV_CHARGE_STG | 2 | 8041 | 1 | `s_m_Load_CONV_CHARGE_STG` |
| 20 | ONE_TIME_FIX | 2 | 8042 | 1 | `s_m_Load_CONV_CHARGE_STG_ONE_TIME_FIX` |
| 21 | CIRCUIT_ORDER_STAGE | 2 | 8043 | 1 | `s_m_Load_CONV_CIRCUIT_ORDER_STAGE` |
| 22 | ONE_TIME_FIX | 2 | 8044 | 1 | `s_m_Load_CONV_CIRCUIT_ORDER_STG_ONE_TIME_FIX` |
| 23 | PRODUCT_XREF_TMP | 2 | 8046 | 1 | `s_m_Load_CTL_PRODUCT_XREF_TMP` |
| 24 | STG_HIST_Insert | 2 | 8077 | 1 | `s_m_Load_ENS_MM_CHARGE_STG_HIST_Insert` |
| 25 | COS_HIST_Insert | 2 | 8078 | 1 | `s_m_Load_ENS_MM_COS_HIST_Insert` |
| 26 | Create_Partition_Table | 2 | 8079 | 1 | `s_m_Load_ENS_MM_Create_Partition_Table` |
| 27 | MM_Rename_Backup | 2 | 8080 | 1 | `s_m_Load_ENS_MM_Rename_Backup` |
| 28 | CIRCUIT_ORDER_STG | 2 | 8268 | 1 | `s_m_Load_PRE_CIRCUIT_ORDER_STG` |
| 29 | CIRCUIT_ORDER_STG | 2 | 8293 | 1 | `s_m_Load_RC_SCB_CIRCUIT_ORDER_STG` |
| 30 | SOURCE_TABLE_COUNTS | 2 | 8358 | 1 | `s_m_Load_SOURCE_TABLE_COUNTS` |
| 31 | SOURCE_TABLE_COUNTS | 2 | 8522 | 2 | `s_m_Validate_SOURCE_TABLE_COUNTS` |
| 32 | ARPU_COS_BASE | 2 | 8567 | 2 | `s_m_load_CDL_ARPU_COS_BASE` |

#### DG_14 — 28 members
- **Sources:** `DUMMY_SRC, DUMMY_SRCE`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Control_Contact_4HR | 1 | 165 | 4 | `s_m_Check_App_Control_Contact_4HR` |
| 2 | App_Control_Status | 1 | 167 | 4 | `s_m_Check_App_Control_Status` |
| 3 | Control_Status_ACP | 1 | 171 | 4 | `s_m_Check_App_Control_Status_ACP` |
| 4 | Status_ASL_PRIME | 1 | 255 | 4 | `s_m_Check_App_Control_Status_ASL_PRIME` |
| 5 | Status_Account_Feed | 1 | 304 | 4 | `s_m_Check_App_Control_Status_Account_Feed` |
| 6 | Status_Blue_Subfeed | 1 | 316 | 4 | `s_m_Check_App_Control_Status_Blue_Subfeed` |
| 7 | Control_Status_Custban | 1 | 380 | 4 | `s_m_Check_App_Control_Status_Custban` |
| 8 | Status_DSL_AIM | 1 | 401 | 4 | `s_m_Check_App_Control_Status_DSL_AIM` |
| 9 | Day_TG_Stats | 1 | 411 | 4 | `s_m_Check_App_Control_Status_Day_TG_Stats` |
| 10 | Status_Dsl_Order | 1 | 412 | 4 | `s_m_Check_App_Control_Status_Dsl_Order` |
| 11 | Control_Status_ECCKT | 1 | 414 | 4 | `s_m_Check_App_Control_Status_ECCKT` |
| 12 | ECCKT_CUST_SERV | 1 | 415 | 4 | `s_m_Check_App_Control_Status_ECCKT_CUST_SERV` |
| 13 | Status_ECCKT_HIST | 1 | 416 | 4 | `s_m_Check_App_Control_Status_ECCKT_HIST` |
| 14 | Status_ECCKT_LTID | 1 | 417 | 4 | `s_m_Check_App_Control_Status_ECCKT_LTID` |
| 15 | Control_Status_ExchangeRate | 1 | 425 | 4 | `s_m_Check_App_Control_Status_ExchangeRate` |
| 16 | Status_ExchangeRate_1HR | 1 | 426 | 4 | `s_m_Check_App_Control_Status_ExchangeRate_1HR` |
| 17 | Status_ExchangeRate_4HR | 1 | 427 | 4 | `s_m_Check_App_Control_Status_ExchangeRate_4HR` |
| 18 | Control_Status_Location | 1 | 442 | 4 | `s_m_Check_App_Control_Status_Location` |
| 19 | Control_Status_LoopQualification | 1 | 443 | 4 | `s_m_Check_App_Control_Status_LoopQualification` |
| 20 | Status_NETEX_CTL | 1 | 445 | 4 | `s_m_Check_App_Control_Status_NETEX_CTL` |
| 21 | Status_NETEX_SAM | 1 | 446 | 4 | `s_m_Check_App_Control_Status_NETEX_SAM` |
| 22 | Status_OFFNET_ASR1 | 1 | 470 | 4 | `s_m_Check_App_Control_Status_OFFNET_ASR1` |
| 23 | Control_Status_Order | 1 | 475 | 4 | `s_m_Check_App_Control_Status_Order` |
| 24 | Status_Red_Subfeed | 1 | 480 | 4 | `s_m_Check_App_Control_Status_Red_Subfeed` |
| 25 | Status_Running_Wkf | 1 | 482 | 4 | `s_m_Check_App_Control_Status_Running_Wkf` |
| 26 | f_service_build | 1 | 483 | 4 | `s_m_Check_App_Control_Status_Running_f_service_build` |
| 27 | Status_SUP_CTL | 1 | 513 | 4 | `s_m_Check_App_Control_Status_SUP_CTL` |
| 28 | Supp_Disp_Actvty | 1 | 519 | 4 | `s_m_Check_App_Control_Status_Supp_Disp_Actvty` |

#### DG_15 — 27 members
- **Sources:** `DUAL, D_TAXMART_PERIOD`
- **Targets:** `FL_GENERATED_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PARAMETERS_D_ENDPOINT | 30 | 12035 | 5 | `s_m_GENERATE_PARAMETERS_D_ENDPOINT` |
| 2 | REVENUE_MNTH_166 | 30 | 12036 | 7 | `s_m_GENERATE_PARAMETERS_LOAD_BILLED_REVENUE_MNTH_166` |
| 3 | REVENUE_QRTR_166 | 30 | 12037 | 7 | `s_m_GENERATE_PARAMETERS_LOAD_BILLED_REVENUE_QRTR_166` |
| 4 | BILLVIZ_MNTH_641 | 30 | 12039 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_BILLVIZ_MNTH_641` |
| 5 | ALLOCATION_MNTH_007 | 30 | 12040 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_007` |
| 6 | ALLOCATION_MNTH_100 | 30 | 12041 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_100` |
| 7 | ALLOCATION_MNTH_125 | 30 | 12042 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_125` |
| 8 | ALLOCATION_MNTH_131 | 30 | 12043 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_131` |
| 9 | ALLOCATION_MNTH_133 | 30 | 12044 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_133` |
| 10 | ALLOCATION_MNTH_166 | 30 | 12045 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_166` |
| 11 | ALLOCATION_MNTH_169 | 30 | 12046 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_169` |
| 12 | ALLOCATION_MNTH_175 | 30 | 12047 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_175` |
| 13 | ALLOCATION_MNTH_624 | 30 | 12050 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_624` |
| 14 | MNTH_BILLVIZ_273 | 30 | 12051 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_BILLVIZ_273` |
| 15 | ALLOCATION_MNTH_S278 | 30 | 12053 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_S278` |
| 16 | ALLOCATION_QRTR_007 | 30 | 12054 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_007` |
| 17 | ALLOCATION_QRTR_100 | 30 | 12055 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_100` |
| 18 | ALLOCATION_QRTR_125 | 30 | 12056 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_125` |
| 19 | ALLOCATION_QRTR_131 | 30 | 12057 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_131` |
| 20 | ALLOCATION_QRTR_133 | 30 | 12058 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_133` |
| 21 | ALLOCATION_QRTR_166 | 30 | 12059 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_166` |
| 22 | ALLOCATION_QRTR_169 | 30 | 12060 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_169` |
| 23 | ALLOCATION_QRTR_175 | 30 | 12061 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_175` |
| 24 | ALLOCATION_QRTR_273 | 30 | 12064 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_273` |
| 25 | ALLOCATION_QRTR_624 | 30 | 12065 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_624` |
| 26 | ALLOCATION_QRTR_641 | 30 | 12066 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_641` |
| 27 | ALLOCATION_QRTR_S278 | 30 | 12068 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_S278` |

#### DG_16 — 24 members
- **Sources:** `TRAIL`
- **Targets:** `CI_DOMAIN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PO_CIRCUIT_REPORT | 33 | 12557 | 2 | `s_m_truncate_ASR_PO_CIRCUIT_REPORT` |
| 2 | ASR_PO_REPORT | 33 | 12558 | 2 | `s_m_truncate_ASR_PO_REPORT` |
| 3 | account_invoice_charge | 33 | 12559 | 2 | `s_m_truncate_account_invoice_charge` |
| 4 | circuit_rename_xref | 33 | 12560 | 2 | `s_m_truncate_circuit_rename_xref` |
| 5 | circuits_oi_xref | 33 | 12561 | 2 | `s_m_truncate_circuits_oi_xref` |
| 6 | truncate_dss_circuit | 33 | 12562 | 2 | `s_m_truncate_dss_circuit` |
| 7 | dss_circuit_hierarchy | 33 | 12563 | 2 | `s_m_truncate_dss_circuit_hierarchy` |
| 8 | truncate_equip_hierarchy | 33 | 12564 | 2 | `s_m_truncate_equip_hierarchy` |
| 9 | truncate_leadset_port | 33 | 12566 | 2 | `s_m_truncate_leadset_port` |
| 10 | truncate_offnet_circuit | 33 | 12567 | 2 | `s_m_truncate_offnet_circuit` |
| 11 | oms_order_item | 33 | 12568 | 2 | `s_m_truncate_oms_order_item` |
| 12 | oms_serv_instance | 33 | 12569 | 2 | `s_m_truncate_oms_serv_instance` |
| 13 | truncate_revenue_charge | 33 | 12570 | 2 | `s_m_truncate_revenue_charge` |
| 14 | truncate_revenue_circuit | 33 | 12571 | 2 | `s_m_truncate_revenue_circuit` |
| 15 | truncate_revenue_invoice | 33 | 12572 | 2 | `s_m_truncate_revenue_invoice` |
| 16 | revenue_invoice_service | 33 | 12573 | 2 | `s_m_truncate_revenue_invoice_service` |
| 17 | invoice_charge_total | 33 | 12574 | 2 | `s_m_truncate_serv_invoice_charge_total` |
| 18 | service_invoice_charge | 33 | 12575 | 2 | `s_m_truncate_service_invoice_charge` |
| 19 | truncate_service_summary | 33 | 12576 | 2 | `s_m_truncate_service_summary` |
| 20 | truncate_si_diversity | 33 | 12577 | 2 | `s_m_truncate_si_diversity` |
| 21 | truncate_task_stat | 33 | 12578 | 2 | `s_m_truncate_task_stat` |
| 22 | task_stat_pool | 33 | 12579 | 2 | `s_m_truncate_task_stat_pool` |
| 23 | truncate_tc_utilization | 33 | 12580 | 2 | `s_m_truncate_tc_utilization` |
| 24 | trouble_mgt_summary | 33 | 12581 | 2 | `s_m_truncate_trouble_mgt_summary` |

#### DG_17 — 24 members
- **Sources:** `DUMMY_SRCE`
- **Targets:** `FF_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | XREF_SEND_RESULTS | 1 | 2068 | 2 | `s_m_Load_DH_GL_CO_ACCT_PROD_XREF_SEND_RESULTS` |
| 2 | SAP_SEND_RESULTS | 1 | 2949 | 2 | `s_m_Load_F_CAPEX_EXTRACT_SAP_SEND_RESULTS` |
| 3 | ACCOUNT_SEND_RESULTS | 1 | 3016 | 2 | `s_m_Load_GL_ACCOUNT_SEND_RESULTS` |
| 4 | AREA_SEND_RESULTS | 1 | 3019 | 2 | `s_m_Load_GL_BUSINESS_AREA_SEND_RESULTS` |
| 5 | TMP_MD5_BDGT | 1 | 3220 | 4 | `s_m_Load_JOURNAL_LINE_AMT_TMP_MD5_BDGT` |
| 6 | TMP_MD5_DAILY | 1 | 3221 | 4 | `s_m_Load_JOURNAL_LINE_AMT_TMP_MD5_DAILY` |
| 7 | TMP_MD5_USD | 1 | 3222 | 4 | `s_m_Load_JOURNAL_LINE_AMT_TMP_MD5_USD` |
| 8 | ASL_GLT0_SUM | 1 | 4653 | 4 | `s_m_Load_RECON_ASL_GLT0_SUM` |
| 9 | ASL_GL_BALANCE | 1 | 4654 | 4 | `s_m_Load_RECON_ASL_GL_BALANCE` |
| 10 | GL_BALANCE_SUM | 1 | 4655 | 4 | `s_m_Load_RECON_ASL_GL_BALANCE_SUM` |
| 11 | RECON_GLT0_DIFF | 1 | 4657 | 4 | `s_m_Load_RECON_GLT0_DIFF` |
| 12 | GLT0_BSEG_COMBO | 1 | 4660 | 4 | `s_m_Load_RECON_SAP_GLT0_BSEG_COMBO` |
| 13 | SAP_GLT0_SUM | 1 | 4661 | 4 | `s_m_Load_RECON_SAP_GLT0_SUM` |
| 14 | SAP_GL_BALANCE | 1 | 4662 | 4 | `s_m_Load_RECON_SAP_GL_BALANCE` |
| 15 | GL_BALANCE_SUM | 1 | 4663 | 4 | `s_m_Load_RECON_SAP_GL_BALANCE_SUM` |
| 16 | Load_SEND_EMAIL | 1 | 4914 | 2 | `s_m_Load_SEND_EMAIL` |
| 17 | GL_BALANCE_ID | 1 | 6125 | 4 | `s_m_Load_TMP_RECON_SAP_GL_BALANCE_ID` |
| 18 | APP_CONTROL_STATUS | 1 | 6273 | 3 | `s_m_Load_UPDATE_END_DT_IN_APP_CONTROL_STATUS` |
| 19 | GL_MASTER_XREF | 1 | 6842 | 2 | `s_m_Truncate_SWP_DH_LEGACY_GL_MASTER_XREF` |
| 20 | XREF_NEXT_MNTH | 1 | 6843 | 2 | `s_m_Truncate_SWP_DH_LEGACY_GL_MASTER_XREF_NEXT_MNTH` |
| 21 | F_BILLING_DETAIL | 1 | 6844 | 2 | `s_m_Truncate_SWP_F_BILLING_DETAIL` |
| 22 | DETAIL_CURR_MNTH | 1 | 6845 | 2 | `s_m_Truncate_SWP_F_BILLING_DETAIL_CURR_MNTH` |
| 23 | DETAIL_NEXT_MNTH | 1 | 6846 | 2 | `s_m_Truncate_SWP_F_BILLING_DETAIL_NEXT_MNTH` |
| 24 | OVERRIDE_MISR_ADJUSTMENT | 1 | 6847 | 2 | `s_m_Truncate_USER_OVERRIDE_MISR_ADJUSTMENT` |

#### DG_18 — 23 members
- **Sources:** `FF_LOAD_STATUS`
- **Targets:** `ASL_LOAD_STATUS`
- **Lookups:** `ASL_LOAD_STATUS`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LOAD_STATUS_LIMS | 30 | 12197 | 5 | `s_m_Load_update_ASL_LOAD_STATUS_LIMS` |
| 2 | OFFNETQUOTEREQUESTSOLUTION_Load_Status | 30 | 12207 | 5 | `s_m_Update_ASL_INC_OFFNETQUOTEREQUESTSOLUTION_Load_Status` |
| 3 | PRICESOLUTIONSEGMENT_Load_Status | 30 | 12208 | 5 | `s_m_Update_ASL_INC_PRICESOLUTIONSEGMENT_Load_Status` |
| 4 | PRICESOLUTION_Load_Status | 30 | 12209 | 5 | `s_m_Update_ASL_INC_PRICESOLUTION_Load_Status` |
| 5 | QUOTEPRODCOMPNTPROPERTY_Load_Status | 30 | 12210 | 5 | `s_m_Update_ASL_INC_QUOTEPRODCOMPNTPROPERTY_Load_Status` |
| 6 | QUOTEPRODUCTCOMPONENT_Load_Status | 30 | 12211 | 5 | `s_m_Update_ASL_INC_QUOTEPRODUCTCOMPONENT_Load_Status` |
| 7 | ASL_LOAD_STATUS | 30 | 12212 | 5 | `s_m_Update_ASL_LOAD_STATUS` |
| 8 | ASL_LOAD_STATUS1 | 30 | 12213 | 5 | `s_m_Update_ASL_LOAD_STATUS1` |
| 9 | Load_Status_APPOINTMENT | 30 | 12215 | 5 | `s_m_Update_ASL_Load_Status_APPOINTMENT` |
| 10 | Load_Status_CDL | 30 | 12216 | 5 | `s_m_Update_ASL_Load_Status_CDL` |
| 11 | Load_Status_ENS | 30 | 12217 | 5 | `s_m_Update_ASL_Load_Status_ENS` |
| 12 | Load_Status_Init | 30 | 12218 | 5 | `s_m_Update_ASL_Load_Status_Init` |
| 13 | Status_KENAN_LATAM | 30 | 12219 | 5 | `s_m_Update_ASL_Load_Status_KENAN_LATAM` |
| 14 | Load_Status_PPP | 30 | 12220 | 5 | `s_m_Update_ASL_Load_Status_PPP` |
| 15 | Load_Status_Recon | 30 | 12221 | 5 | `s_m_Update_ASL_Load_Status_Recon` |
| 16 | Status_TASK_Entry | 30 | 12222 | 5 | `s_m_Update_ASL_Load_Status_TASK_Entry` |
| 17 | Load_Status_WFMT | 30 | 12223 | 5 | `s_m_Update_ASL_Load_Status_WFMT` |
| 18 | qoa_prd_component | 30 | 12224 | 5 | `s_m_Update_ASL_Load_Status_qoa_prd_component` |
| 19 | qoa_service_element | 30 | 12225 | 5 | `s_m_Update_ASL_Load_Status_qoa_service_element` |
| 20 | service_element_attr | 30 | 12226 | 5 | `s_m_Update_ASL_Load_Status_qoa_service_element_attr` |
| 21 | task_inst_params | 30 | 12227 | 5 | `s_m_Update_ASL_Load_Status_task_inst_params` |
| 22 | load_status_RSOR | 30 | 12232 | 5 | `s_m_Updated_ASL_load_status_RSOR` |
| 23 | ASL_LOAD_STATUS | 30 | 12255 | 5 | `s_m_update_ASL_LOAD_STATUS` |

#### DG_19 — 21 members
- **Sources:** `USOC_BILLED`
- **Targets:** `CODS_NETEX, USOC_BILLED`
- **Lookups:** `USOC_OCC_CATGRY`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | OCC_CATGRY_TYP | 2 | 8472 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP` |
| 2 | CATGRY_TYP_CTL | 2 | 8473 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL` |
| 3 | CATGRY_TYP_CTL1 | 2 | 8474 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL1` |
| 4 | CATGRY_TYP_CTL11 | 2 | 8475 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL11` |
| 5 | CATGRY_TYP_CTL110 | 2 | 8476 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL110` |
| 6 | CATGRY_TYP_CTL111 | 2 | 8477 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL111` |
| 7 | CATGRY_TYP_CTL112 | 2 | 8478 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL112` |
| 8 | CATGRY_TYP_CTL113 | 2 | 8479 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL113` |
| 9 | CATGRY_TYP_CTL114 | 2 | 8480 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL114` |
| 10 | CATGRY_TYP_CTL115 | 2 | 8481 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL115` |
| 11 | CATGRY_TYP_CTL116 | 2 | 8482 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL116` |
| 12 | CATGRY_TYP_CTL1161 | 2 | 8483 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL1161` |
| 13 | CATGRY_TYP_CTL1162 | 2 | 8484 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL1162` |
| 14 | CATGRY_TYP_CTL12 | 2 | 8485 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL12` |
| 15 | CATGRY_TYP_CTL13 | 2 | 8486 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL13` |
| 16 | CATGRY_TYP_CTL14 | 2 | 8487 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL14` |
| 17 | CATGRY_TYP_CTL15 | 2 | 8488 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL15` |
| 18 | CATGRY_TYP_CTL16 | 2 | 8489 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL16` |
| 19 | CATGRY_TYP_CTL17 | 2 | 8490 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL17` |
| 20 | CATGRY_TYP_CTL18 | 2 | 8491 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL18` |
| 21 | CATGRY_TYP_CTL19 | 2 | 8492 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OCC_CATGRY_TYP_CTL19` |

#### DG_20 — 20 members
- **Sources:** `DRIVING_KEY1, DUMMY`
- **Targets:** `DRIVING_KEY2, FF_LOAD_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_ADDRESS_DK2 | 6 | 9357 | 3 | `s_m_Load_ADDRESS_DK2` |
| 2 | TN_ORDER_DK2 | 6 | 9359 | 3 | `s_m_Load_ASL_TN_ORDER_DK2` |
| 3 | LINE_ORDER_DK2 | 6 | 9364 | 3 | `s_m_Load_CPO_TN_LINE_ORDER_DK2` |
| 4 | LNP_JEOPARDY_DK2 | 6 | 9413 | 3 | `s_m_Load_LNP_JEOPARDY_DK2` |
| 5 | LNP_ORDER_DK2 | 6 | 9414 | 3 | `s_m_Load_LNP_ORDER_DK2` |
| 6 | LIDB_FEATURES_DK2 | 6 | 9416 | 3 | `s_m_Load_ORDER_CNAM_LIDB_FEATURES_DK2` |
| 7 | LIST_FEATURES_DK2 | 6 | 9417 | 3 | `s_m_Load_ORDER_DIR_LIST_FEATURES_DK2` |
| 8 | E911_FEATURES_DK2 | 6 | 9418 | 3 | `s_m_Load_ORDER_E911_FEATURES_DK2` |
| 9 | ORDER_FEATURES_DK2 | 6 | 9419 | 3 | `s_m_Load_ORDER_FEATURES_DK2` |
| 10 | TOLLFREE_FEATURES_DK2 | 6 | 9420 | 3 | `s_m_Load_ORDER_TOLLFREE_FEATURES_DK2` |
| 11 | PARENT_TRANSACTION_DK2 | 6 | 9422 | 3 | `s_m_Load_PARENT_TRANSACTION_DK2` |
| 12 | CD_SIPTRUNKINGREMOTELOC_DK2 | 6 | 9424 | 3 | `s_m_Load_QO_CD_SIPTRUNKINGREMOTELOC_DK2` |
| 13 | SL_ORDER_DK2 | 6 | 9429 | 3 | `s_m_Load_SL_ORDER_DK2` |
| 14 | Load_SUBSCRIBER_DK2 | 6 | 9431 | 3 | `s_m_Load_SUBSCRIBER_DK2` |
| 15 | SUBSCRIBER_LINE_DK2 | 6 | 9432 | 3 | `s_m_Load_SUBSCRIBER_LINE_DK2` |
| 16 | ORDER_ACTIVITY_DK2 | 6 | 9435 | 3 | `s_m_Load_TN_LINE_ORDER_ACTIVITY_DK2` |
| 17 | LINE_ORDER_DK2 | 6 | 9436 | 3 | `s_m_Load_TN_LINE_ORDER_DK2` |
| 18 | ORDER_PRICE_DK2 | 6 | 9437 | 3 | `s_m_Load_TN_LINE_ORDER_PRICE_DK2` |
| 19 | TN_ORDER_DK2 | 29 | 11942 | 3 | `s_m_Load_TN_ORDER_DK2` |
| 20 | SUBSCRIBER_LINE_DK2 | 29 | 11945 | 3 | `s_m_Load_TOLLFREE_SUBSCRIBER_LINE_DK2` |

#### DG_21 — 18 members
- **Sources:** `ASL_LOAD_STATUS`
- **Targets:** `FF_PARAMETER_FILE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Parameter_File_4HR | 5 | 9200 | 2 | `s_m_Generate_Parameter_File_4HR` |
| 2 | File_Arch_Incr | 5 | 9201 | 4 | `s_m_Generate_Parameter_File_Arch_Incr` |
| 3 | Parameter_File_BPCC | 5 | 9202 | 2 | `s_m_Generate_Parameter_File_BPCC` |
| 4 | File_BPCC_KENANFX | 5 | 9203 | 2 | `s_m_Generate_Parameter_File_BPCC_KENANFX` |
| 5 | File_BPC_CRIS | 5 | 9205 | 2 | `s_m_Generate_Parameter_File_BPC_CRIS` |
| 6 | File_BPC_ENS | 5 | 9206 | 4 | `s_m_Generate_Parameter_File_BPC_ENS` |
| 7 | File_DK2_CPO | 5 | 9208 | 2 | `s_m_Generate_Parameter_File_DK2_CPO` |
| 8 | File_ENS_MM | 5 | 9209 | 3 | `s_m_Generate_Parameter_File_ENS_MM` |
| 9 | Parameter_File_LIMS | 5 | 9215 | 2 | `s_m_Generate_Parameter_File_LIMS` |
| 10 | Parameter_File_MB | 5 | 9216 | 2 | `s_m_Generate_Parameter_File_MB` |
| 11 | File_PPP_BPC | 5 | 9217 | 2 | `s_m_Generate_Parameter_File_PPP_BPC` |
| 12 | Parameter_File_RECON | 5 | 9218 | 4 | `s_m_Generate_Parameter_File_RECON` |
| 13 | Parameter_File_WFMT | 5 | 9220 | 2 | `s_m_Generate_Parameter_File_WFMT` |
| 14 | CASH_ARR_ENRL | 5 | 9223 | 2 | `s_m_Generate_Paramfile_AR_CASH_ARR_ENRL` |
| 15 | IPS_TOKEN_DETAILS | 5 | 9224 | 2 | `s_m_Generate_ParmFile_IPS_TOKEN_DETAILS` |
| 16 | Recovery_Parameter_File | 5 | 9225 | 2 | `s_m_Generate_Recovery_Parameter_File` |
| 17 | HIST_Parameter_File | 5 | 9226 | 2 | `s_m_Generate_TN_LINE_ORDER_HIST_Parameter_File` |
| 18 | file_BPC_LATIS | 5 | 9227 | 2 | `s_m_Generate_parameter_file_BPC_LATIS` |

#### DG_22 — 17 members
- **Sources:** `DUMMY_SRC_DW_SEC_COM_NBR`
- **Targets:** `CODS_NETINV, DUMMY_TGT_DW_SEC_COM_NBR`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COMPANY_NBR_CARD | 1 | 7653 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CARD` |
| 2 | COMPANY_NBR_CHASSIS | 1 | 7654 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_CHASSIS` |
| 3 | COMPANY_NBR_EQUIPMENT | 1 | 7669 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_EQUIPMENT` |
| 4 | EQUIPMENT_CARD_CHASIS | 1 | 7670 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_EQUIPMENT_CARD_CHASIS` |
| 5 | NBR_EQUIPMENT_HOLDER | 1 | 7671 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_EQUIPMENT_HOLDER` |
| 6 | EQUIPMENT_IN_HOLDER | 1 | 7672 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_EQUIPMENT_IN_HOLDER` |
| 7 | LEASED_TRAIL_DETAIL | 1 | 7673 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_LEASED_TRAIL_DETAIL` |
| 8 | NBR_NETWORK_ELEMENT | 1 | 7674 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_NETWORK_ELEMENT` |
| 9 | NETWORK_ELEMENT_ATTR | 1 | 7675 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_NETWORK_ELEMENT_ATTR` |
| 10 | NBR_PHYS_STRUCT | 1 | 7714 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_PHYS_STRUCT` |
| 11 | COMPANY_NBR_RACK | 1 | 7741 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_RACK` |
| 12 | SOURCE_NETWORK_ELEMENT | 1 | 7745 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_SOURCE_NETWORK_ELEMENT` |
| 13 | TRAIL_SOURCE_ATTR | 1 | 7747 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_TRAIL_SOURCE_ATTR` |
| 14 | NBR_TRUNK_GROUP | 1 | 7748 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_TRUNK_GROUP` |
| 15 | TRUNK_GROUP_IP | 1 | 7749 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_TRUNK_GROUP_IP` |
| 16 | NBR_VIRTUAL_CIRCUIT | 1 | 7751 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_VIRTUAL_CIRCUIT` |
| 17 | VIRTUAL_PRIVATE_NETWORK | 1 | 7752 | 2 | `s_m_update_DW_SECURE_COMPANY_NBR_VIRTUAL_PRIVATE_NETWORK` |

#### DG_23 — 17 members
- **Sources:** `CDN_ORDERS_IN`
- **Targets:** `URL_PREFIX_DIM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STAGE_SESSIONS_UPD | 1 | 697 | 2 | `s_m_LOAD_AL_FMS_EVENT_STAGE_SESSIONS_UPD` |
| 2 | IL_COSERVER_WKLY | 1 | 775 | 2 | `s_m_LOAD_IL_COSERVER_WKLY` |
| 3 | CNTRY_DLY_MLY | 1 | 808 | 3 | `s_m_LOAD_STREAM_CLIENT_CNTRY_DLY_MLY` |
| 4 | MAT_VW_REFRESH | 1 | 809 | 2 | `s_m_LOAD_STREAM_CLI_MAT_VW_REFRESH` |
| 5 | AG_DLY_MLY | 1 | 812 | 3 | `s_m_LOAD_STREAM_MAT_VIEW_AG_DLY_MLY` |
| 6 | REFRESH_AG_HLY | 1 | 813 | 2 | `s_m_LOAD_STREAM_MAT_VIEW_REFRESH_AG_HLY` |
| 7 | REFRESH_DEFAULT_ALL | 1 | 814 | 2 | `s_m_LOAD_STREAM_MAT_VIEW_REFRESH_DEFAULT_ALL` |
| 8 | VIEW_REFRESH_SCID | 1 | 815 | 2 | `s_m_LOAD_STREAM_MAT_VIEW_REFRESH_SCID` |
| 9 | REFRESH_STREAM_ID | 1 | 816 | 2 | `s_m_LOAD_STREAM_MAT_VIEW_REFRESH_STREAM_ID` |
| 10 | STREAM_DLY_MLY | 1 | 817 | 3 | `s_m_LOAD_STREAM_MAT_VIEW_STREAM_DLY_MLY` |
| 11 | DEFALL_DLY_MLY | 1 | 818 | 5 | `s_m_LOAD_STREAM_MAT_VW_AG_DEFALL_DLY_MLY` |
| 12 | STREAM_RTM_RLLP | 1 | 819 | 2 | `s_m_LOAD_STREAM_RTM_RLLP` |
| 13 | RTM_RLLP_ALONE | 1 | 820 | 2 | `s_m_LOAD_STREAM_RTM_RLLP_ALONE` |
| 14 | SCID_DLY_MLY | 1 | 821 | 3 | `s_m_LOAD_STREAM_SCID_DLY_MLY` |
| 15 | CNTRY_DLY_MLY | 1 | 822 | 3 | `s_m_LOAD_STREAM_SERVING_CNTRY_DLY_MLY` |
| 16 | MAT_VW_REFRESH | 1 | 823 | 2 | `s_m_LOAD_STREAM_SERV_MAT_VW_REFRESH` |
| 17 | PREFIX_DIM_CLEANUP | 1 | 6853 | 3 | `s_m_UPDATE_URL_PREFIX_DIM_CLEANUP` |

#### DG_24 — 13 members
- **Sources:** `DUMMY`
- **Targets:** `DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CDNC_ORDERS_SUBSTEP | 1 | 705 | 5 | `s_m_LOAD_CDNC_ORDERS_SUBSTEP` |
| 2 | VHOST_DAILY_MV | 1 | 784 | 4 | `s_m_LOAD_ORGSTG_VHOST_DAILY_MV` |
| 3 | T_TABLES_SUMM | 1 | 792 | 3 | `s_m_LOAD_ROLLUP_4HOURS_T_TABLES_SUMM` |
| 4 | T_TABLES_DAILY | 1 | 793 | 5 | `s_m_LOAD_ROLLUP_T_TABLES_DAILY` |
| 5 | STREAMING_5MIN_ROLLUP | 1 | 804 | 3 | `s_m_LOAD_STREAMING_5MIN_ROLLUP` |
| 6 | SUMM_UPD_95PCT | 1 | 805 | 4 | `s_m_LOAD_STREAMING_MNTHLY_SUMM_UPD_95PCT` |
| 7 | UPD_95PCT_URLPFX | 1 | 806 | 4 | `s_m_LOAD_STREAMING_MNTHLY_SUMM_UPD_95PCT_URLPFX` |
| 8 | CACHING_PF_FILES | 1 | 6722 | 3 | `s_m_MOVE_CACHING_PF_FILES` |
| 9 | FILE_TO_WINDOWS | 1 | 6734 | 1 | `s_m_Move_ACCOUNT_FEED_FILE_TO_WINDOWS` |
| 10 | SUBFEED_TO_WINDOWS | 1 | 6735 | 1 | `s_m_Move_BLUE_SUBFEED_TO_WINDOWS` |
| 11 | SUBFEED_TO_WINDOWS | 1 | 6736 | 1 | `s_m_Move_RED_SUBFEED_TO_WINDOWS` |
| 12 | AL_STAGE_TABLES | 1 | 6823 | 3 | `s_m_TRUNCATE_AL_STAGE_TABLES` |
| 13 | SUMMARY_PUB_PROP | 1 | 6854 | 4 | `s_m_UPD_95PCT_SUMMARY_PUB_PROP` |

#### DG_25 — 13 members
- **Sources:** `DUMMY_SRC_DW_SEC_COM_NBR`
- **Targets:** `CRPL_GCR, DUMMY_TGT_DW_SEC_COM_NBR`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GCR_AFFECTED_OBJECTS | 1 | 6925 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_AFFECTED_OBJECTS` |
| 2 | GCR_AFFOBJ_OUTWIN | 1 | 6926 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_AFFOBJ_OUTWIN` |
| 3 | GCR_AFFOBJ_SVCIMP | 1 | 6927 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_AFFOBJ_SVCIMP` |
| 4 | GCR_BUSORG_IMPACT | 1 | 6928 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_BUSORG_IMPACT` |
| 5 | GCR_OUTAGE_WINDOW | 1 | 6929 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_OUTAGE_WINDOW` |
| 6 | GCR_SERVICE_IMPACT | 1 | 6930 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_SERVICE_IMPACT` |
| 7 | IMPACT_SWITCH_HIT | 1 | 6931 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_SERVICE_IMPACT_SWITCH_HIT` |
| 8 | SI_NOTIF_HIST | 1 | 6932 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_SI_NOTIF_HIST` |
| 9 | TABLE_ACT_ENTRY | 1 | 6933 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_ACT_ENTRY` |
| 10 | TABLE_CLOSE_CASE | 1 | 6934 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_CLOSE_CASE` |
| 11 | TABLE_GBST_ELM | 1 | 6935 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_GBST_ELM` |
| 12 | GCR_WINDOW_LOCATION | 1 | 6936 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_WINDOW_LOCATION` |
| 13 | GCR_WINDOW_SITE | 1 | 6937 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_WINDOW_SITE` |

#### DG_26 — 13 members
- **Sources:** `DUAL, DUAL_BILLING_PERIOD, D_TAXMART_PERIOD`
- **Targets:** `FL_GENERATED_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_166 | 30 | 12038 | 7 | `s_m_GENERATE_PARAMETERS_LOAD_BILLED_REVENUE_YR_166` |
| 2 | ALLOCATION_YR_007 | 30 | 12069 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_007` |
| 3 | ALLOCATION_YR_100 | 30 | 12070 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_100` |
| 4 | ALLOCATION_YR_125 | 30 | 12071 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_125` |
| 5 | ALLOCATION_YR_131 | 30 | 12072 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_131` |
| 6 | ALLOCATION_YR_133 | 30 | 12073 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_133` |
| 7 | ALLOCATION_YR_166 | 30 | 12074 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_166` |
| 8 | ALLOCATION_YR_169 | 30 | 12075 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_169` |
| 9 | ALLOCATION_YR_175 | 30 | 12076 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_175` |
| 10 | ALLOCATION_YR_273 | 30 | 12079 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_273` |
| 11 | ALLOCATION_YR_624 | 30 | 12080 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_624` |
| 12 | ALLOCATION_YR_641 | 30 | 12081 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_641` |
| 13 | ALLOCATION_YR_S278 | 30 | 12083 | 7 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_S278` |

#### DG_27 — 12 members
- **Sources:** `D_TAXMART_PERIOD`
- **Targets:** `FL_GENERATED_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DT_FOR_GAAP | 12 | 9914 | 2 | `s_m_GENERATE_ACCT_PERIOD_DT_FOR_GAAP` |
| 2 | PARAMETERS_EXEMPTIONS_CDC | 12 | 9915 | 2 | `s_m_GENERATE_PARAMETERS_EXEMPTIONS_CDC` |
| 3 | PARAMETERS_EXEMPTIONS_IDC | 12 | 9916 | 2 | `s_m_GENERATE_PARAMETERS_EXEMPTIONS_IDC` |
| 4 | PARAMETERS_EXEMPTIONS_KENAN | 12 | 9917 | 2 | `s_m_GENERATE_PARAMETERS_EXEMPTIONS_KENAN` |
| 5 | F_MOU_TAXMART | 12 | 9918 | 4 | `s_m_GENERATE_PARAMETERS_F_MOU_TAXMART` |
| 6 | REPORT_TAXES_BILLED | 12 | 9919 | 7 | `s_m_GENERATE_PARAMETERS_F_TR_REPORT_TAXES_BILLED` |
| 7 | MANUAL_CREDIT_CDC | 12 | 9920 | 2 | `s_m_GENERATE_PARAMETERS_LOAD_MANUAL_CREDIT_CDC` |
| 8 | MANUAL_CREDIT_IDC | 12 | 9921 | 2 | `s_m_GENERATE_PARAMETERS_LOAD_MANUAL_CREDIT_IDC` |
| 9 | WITH_MANUAL_CREDIT | 12 | 9927 | 2 | `s_m_GENERATE_PARAMETERS_RECON_ORACLE_GL_WITH_MANUAL_CREDIT` |
| 10 | PARAMETERS_TAXES_BILLED | 12 | 9928 | 7 | `s_m_GENERATE_PARAMETERS_TAXES_BILLED` |
| 11 | PARAMETERS_TAXES_FILED | 12 | 9929 | 7 | `s_m_GENERATE_PARAMETERS_TAXES_FILED` |
| 12 | PARAMETERS_TR_REPORT | 12 | 9930 | 2 | `s_m_GENERATE_PARAMETERS_TR_REPORT` |

#### DG_28 — 12 members
- **Sources:** `BILL_INVOICE`
- **Targets:** `FF_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ITEM_TAX_CDC | 11 | 9871 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_INVOICE_ITEM_TAX_CDC` |
| 2 | NO_IN_INVOICE | 11 | 9872 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE` |
| 3 | IN_INVOICE_CDC | 11 | 9873 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_CDC` |
| 4 | IN_INVOICE_DETAIL | 11 | 9874 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_DETAIL` |
| 5 | INVOICE_DETAIL_CDC | 11 | 9875 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_DETAIL_CDC` |
| 6 | INVOICE_DETAIL_KENANFX | 11 | 9876 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_DETAIL_KENANFX` |
| 7 | DETAIL_KENAN_LATAM | 11 | 9877 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_DETAIL_KENAN_LATAM` |
| 8 | INVOICE_ITEM_TAX | 11 | 9878 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_ITEM_TAX` |
| 9 | ITEM_TAX_KENANFX | 11 | 9879 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_ITEM_TAX_KENANFX` |
| 10 | TAX_KENAN_LATAM | 11 | 9880 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_ITEM_TAX_KENAN_LATAM` |
| 11 | IN_INVOICE_KENANFX | 11 | 9881 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_KENANFX` |
| 12 | INVOICE_KENAN_LATAM | 11 | 9882 | 2 | `s_m_Load_MAX_AND_MIN_BILL_REF_NO_IN_INVOICE_KENAN_LATAM` |

#### DG_29 — 12 members
- **Sources:** `M_JOB_CONTROL_STATUS`
- **Targets:** `FF_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Late_Source_Files | 7 | 9444 | 4 | `s_m_Generate_Alarm_of_Late_Source_Files` |
| 2 | TG_STATS_NOCM | 7 | 9446 | 2 | `s_m_Generate_Parameters_DAY_TG_STATS_NOCM` |
| 3 | TG_STATS_SONUS | 7 | 9447 | 2 | `s_m_Generate_Parameters_DAY_TG_STATS_SONUS` |
| 4 | STATS_DSP_CPS | 7 | 9448 | 4 | `s_m_Generate_Parameters_F_CONGEST_STATS_DSP_CPS` |
| 5 | DAY_SYSTEM_STATS | 7 | 9449 | 4 | `s_m_Generate_Parameters_F_DAY_SYSTEM_STATS` |
| 6 | HOUR_CONGEST_STATS | 7 | 9450 | 4 | `s_m_Generate_Parameters_F_HOUR_CONGEST_STATS` |
| 7 | HOUR_SYSTEM_STATS | 7 | 9451 | 4 | `s_m_Generate_Parameters_F_HOUR_SYSTEM_STATS` |
| 8 | TG_STATS_NOCM | 7 | 9452 | 4 | `s_m_Generate_Parameters_HOUR_TG_STATS_NOCM` |
| 9 | TG_STATS_SONUS | 7 | 9453 | 4 | `s_m_Generate_Parameters_HOUR_TG_STATS_SONUS` |
| 10 | Generate_Parameters_NOCM | 7 | 9454 | 6 | `s_m_Generate_Parameters_NOCM` |
| 11 | CUST_UTIL_NOTIFY | 7 | 9455 | 4 | `s_m_Generate_Parameters_W_CUST_UTIL_NOTIFY` |
| 12 | TG_UTIL_NOTIFY | 7 | 9456 | 4 | `s_m_Generate_Parameters_W_TG_UTIL_NOTIFY` |

#### DG_30 — 12 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_MNTH, BILLED_REVENUE_TAX_VW_MNTH`
- **Targets:** `F_RVN_CTGRY_ALLCTN_PRCNT_MNTH`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_MNTH_007 | 1 | 59 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_007` |
| 2 | REVENUE_MNTH_100 | 1 | 60 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_100` |
| 3 | REVENUE_MNTH_125 | 1 | 61 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_125` |
| 4 | REVENUE_MNTH_131 | 1 | 62 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_131` |
| 5 | REVENUE_MNTH_133 | 1 | 63 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_133` |
| 6 | REVENUE_MNTH_206 | 1 | 67 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_206` |
| 7 | REVENUE_MNTH_242 | 1 | 68 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_242` |
| 8 | REVENUE_MNTH_273 | 1 | 69 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_273` |
| 9 | REVENUE_MNTH_624 | 1 | 70 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_624` |
| 10 | REVENUE_MNTH_641 | 1 | 71 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_641` |
| 11 | REVENUE_MNTH_CBP | 1 | 72 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_CBP` |
| 12 | REVENUE_MNTH_S278 | 1 | 73 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_S278` |

#### DG_31 — 11 members
- **Sources:** `M_JOB_CONTROL_STATUS`
- **Targets:** `FF_PARAMETER_FILE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Check_PostCorr_XCDR | 3 | 8733 | 2 | `s_m_Generate_Parameters_Check_PostCorr_XCDR` |
| 2 | Parameters_Cust_Stats | 3 | 8734 | 4 | `s_m_Generate_Parameters_Cust_Stats` |
| 3 | DAY_CONGEST_STATS | 3 | 8735 | 4 | `s_m_Generate_Parameters_F_DAY_CONGEST_STATS` |
| 4 | Parameters_F_DRE | 3 | 8736 | 4 | `s_m_Generate_Parameters_F_DRE` |
| 5 | STATS_SONUS_SBC7K | 3 | 8737 | 4 | `s_m_Generate_Parameters_F_RAW_TG_STATS_SONUS_SBC7K` |
| 6 | SYSTEM_STATS_v2 | 3 | 8738 | 3 | `s_m_Generate_Parameters_F_SYSTEM_STATS_v2` |
| 7 | Parameters_License_Stats | 3 | 8739 | 4 | `s_m_Generate_Parameters_License_Stats` |
| 8 | Parameters_Rollup_Daily | 3 | 8740 | 5 | `s_m_Generate_Parameters_Rollup_Daily` |
| 9 | Parameters_Rollup_Hourly | 3 | 8741 | 3 | `s_m_Generate_Parameters_Rollup_Hourly` |
| 10 | Parameters_Rollup_Weekly | 3 | 8742 | 5 | `s_m_Generate_Parameters_Rollup_Weekly` |
| 11 | Sonus_TG_STATS | 3 | 8743 | 4 | `s_m_Generate_Parameters_Sonus_TG_STATS` |

#### DG_32 — 11 members
- **Sources:** `DUMMY_SRCE`
- **Targets:** `STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Lucene_Index_TG | 1 | 562 | 3 | `s_m_Cleanup_Solr_Lucene_Index_TG` |
| 2 | Lucene_Index_CCPUtil | 1 | 6781 | 2 | `s_m_Refresh_Solr_Lucene_Index_CCPUtil` |
| 3 | Lucene_Index_Contact | 1 | 6782 | 2 | `s_m_Refresh_Solr_Lucene_Index_Contact` |
| 4 | Lucene_Index_Custban | 1 | 6783 | 2 | `s_m_Refresh_Solr_Lucene_Index_Custban` |
| 5 | Lucene_Index_ExchangeRate | 1 | 6784 | 2 | `s_m_Refresh_Solr_Lucene_Index_ExchangeRate` |
| 6 | Lucene_Index_Location | 1 | 6785 | 2 | `s_m_Refresh_Solr_Lucene_Index_Location` |
| 7 | Lucene_Index_LoopQualification | 1 | 6786 | 2 | `s_m_Refresh_Solr_Lucene_Index_LoopQualification` |
| 8 | Lucene_Index_Order | 1 | 6787 | 2 | `s_m_Refresh_Solr_Lucene_Index_Order` |
| 9 | Index_TG_Daily | 1 | 6788 | 2 | `s_m_Refresh_Solr_Lucene_Index_TG_Daily` |
| 10 | Index_TG_Hourly | 1 | 6789 | 2 | `s_m_Refresh_Solr_Lucene_Index_TG_Hourly` |
| 11 | Lucene_Index_TNLookup | 1 | 6790 | 2 | `s_m_Refresh_Solr_Lucene_Index_TNLookup` |

#### DG_33 — 11 members
- **Sources:** `DUMMY_SRC, DUMMY_SRCE`
- **Targets:** `DUMMY_TGT_1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Status_ACT_ENTRY | 1 | 172 | 4 | `s_m_Check_App_Control_Status_ACT_ENTRY` |
| 2 | Control_Status_CASE | 1 | 317 | 4 | `s_m_Check_App_Control_Status_CASE` |
| 3 | Control_Status_SAM | 1 | 484 | 4 | `s_m_Check_App_Control_Status_SAM` |
| 4 | Status_SAM_DELAY | 1 | 485 | 4 | `s_m_Check_App_Control_Status_SAM_DELAY` |
| 5 | Status_SAM_EMEA | 1 | 486 | 4 | `s_m_Check_App_Control_Status_SAM_EMEA` |
| 6 | Status_SAM_LATAM | 1 | 488 | 4 | `s_m_Check_App_Control_Status_SAM_LATAM` |
| 7 | SAM_SYNCH_LATAM | 1 | 489 | 4 | `s_m_Check_App_Control_Status_SAM_SYNCH_LATAM` |
| 8 | Status_SMMART_Controller | 1 | 503 | 4 | `s_m_Check_App_Control_Status_SMMART_Controller` |
| 9 | Status_SM_TTR | 1 | 504 | 4 | `s_m_Check_App_Control_Status_SM_TTR` |
| 10 | Status_STATUS_CHANGE | 1 | 508 | 4 | `s_m_Check_App_Control_Status_STATUS_CHANGE` |
| 11 | ASL_GRANITE_SST2 | 1 | 1971 | 4 | `s_m_Load_Check_App_Control_Status_ASL_GRANITE_SST2` |

#### DG_34 — 10 members
- **Sources:** `OMS_ORDER, SERVICE_AGREEMENT`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CAS_LKP_ratedfeature | 2 | 7993 | 1 | `s_m_Load_CAS_LKP_ratedfeature` |
| 2 | CAS_LKP_submarket | 2 | 7994 | 1 | `s_m_Load_CAS_LKP_submarket` |
| 3 | ASSET_STG_ACT | 2 | 8019 | 1 | `s_m_Load_CIRCUIT_ASSET_STG_ACT` |
| 4 | STG_ACT_FINAL | 2 | 8020 | 1 | `s_m_Load_CIRCUIT_ASSET_STG_ACT_FINAL` |
| 5 | ASSET_STG_EXP | 2 | 8021 | 1 | `s_m_Load_CIRCUIT_ASSET_STG_EXP` |
| 6 | STG_EXP_FINAL | 2 | 8022 | 1 | `s_m_Load_CIRCUIT_ASSET_STG_EXP_FINAL` |
| 7 | ASSET_STG_TMP | 2 | 8023 | 1 | `s_m_Load_CIRCUIT_ASSET_STG_TMP` |
| 8 | SERVICE_IMG_LKP | 2 | 8061 | 1 | `s_m_Load_DIR_SERVICE_IMG_LKP` |
| 9 | PROD_VER_LKP | 2 | 8193 | 1 | `s_m_Load_OMS_PROD_VER_LKP` |
| 10 | AGREEMENT_FEATURE_LKP | 2 | 8342 | 1 | `s_m_Load_SERVICE_AGREEMENT_FEATURE_LKP` |

#### DG_35 — 10 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, ORDER_PRODUCT_INCR_AMT, ORDER_PRODUCT_INCR_AMT1`
- **Targets:** `CODS, ORDER_PRODUCT_INCR_AMT`
- **Lookups:** `CUSTOMER_ORDER, L3AR_GL_GOV_REV_VALUES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_INCR_AMT | 11 | 9835 | 10 | `s_m_LOAD_PROD_ORDER_PRODUCT_INCR_AMT` |
| 2 | PRODUCT_INCR_AMT | 11 | 9836 | 10 | `s_m_LOAD_SDP_ORDER_PRODUCT_INCR_AMT` |
| 3 | PRODUCT_INCR_AMT | 13 | 10049 | 9 | `s_m_Load_BM_ORDER_PRODUCT_INCR_AMT` |
| 4 | PRODUCT_INCR_AMT | 18 | 10551 | 9 | `s_m_Load_EASE_CABS_ORDER_PRODUCT_INCR_AMT` |
| 5 | PRODUCT_INCR_AMT | 18 | 10554 | 10 | `s_m_Load_EIS_ORDER_PRODUCT_INCR_AMT` |
| 6 | PRODUCT_INCR_AMT | 18 | 10558 | 9 | `s_m_Load_ENS_MM_ORDER_PRODUCT_INCR_AMT` |
| 7 | PRODUCT_INCR_AMT | 21 | 10812 | 10 | `s_m_Load_ISM_ORDER_PRODUCT_INCR_AMT` |
| 8 | PRODUCT_INCR_AMT | 22 | 11018 | 10 | `s_m_Load_NETWORX_ORDER_PRODUCT_INCR_AMT` |
| 9 | PRODUCT_INCR_AMT | 22 | 11051 | 9 | `s_m_Load_QF_ORDER_PRODUCT_INCR_AMT` |
| 10 | PRODUCT_INCR_AMT | 28 | 11777 | 9 | `s_m_Load_VLOCITY_ORDER_PRODUCT_INCR_AMT` |

#### DG_36 — 10 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_YR, BILLED_REVENUE_TAX_VW_YR, BILLED_REVENUE_TAX_VW_YR2`
- **Targets:** `F_RVN_CTGRY_ALLCTN_PRCNT_YR`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_007 | 1 | 89 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_007` |
| 2 | REVENUE_YR_100 | 1 | 90 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_100` |
| 3 | REVENUE_YR_125 | 1 | 91 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_125` |
| 4 | REVENUE_YR_131 | 1 | 92 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_131` |
| 5 | REVENUE_YR_133 | 1 | 93 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_133` |
| 6 | REVENUE_YR_206 | 1 | 97 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_206` |
| 7 | REVENUE_YR_242 | 1 | 98 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_242` |
| 8 | REVENUE_YR_624 | 1 | 100 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_624` |
| 9 | REVENUE_YR_CBP | 1 | 102 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_CBP` |
| 10 | REVENUE_YR_S278 | 1 | 103 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_S278` |

#### DG_37 — 10 members
- **Sources:** `DUMMY_SRC`
- **Targets:** `ASLNTFLX, STG_WAVELENGTH_HIERARCHY_SVC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | WAVELENGTH_HIERARCHY_SVC | 1 | 5331 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC` |
| 2 | WAVELENGTH_HIERARCHY_SVC1 | 1 | 5332 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC1` |
| 3 | WAVELENGTH_HIERARCHY_SVC2 | 1 | 5334 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC2` |
| 4 | WAVELENGTH_HIERARCHY_SVC3 | 1 | 5335 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC3` |
| 5 | WAVELENGTH_HIERARCHY_SVC4 | 1 | 5336 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC4` |
| 6 | WAVELENGTH_HIERARCHY_SVC5 | 1 | 5337 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC5` |
| 7 | WAVELENGTH_HIERARCHY_SVC6 | 1 | 5338 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC6` |
| 8 | WAVELENGTH_HIERARCHY_SVC7 | 1 | 5339 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC7` |
| 9 | WAVELENGTH_HIERARCHY_SVC8 | 1 | 5340 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC8` |
| 10 | WAVELENGTH_HIERARCHY_SVC9 | 1 | 5341 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY_SVC9` |

#### DG_38 — 10 members
- **Sources:** `DSS_CLR`
- **Targets:** `DSS_CIRCUIT_HIERARCHY`
- **Lookups:** `CI_DOMAIN, DSS_CIRCUIT, DSS_CIRCUIT_DESIGN, DSS_CIRCUIT_ENDPOINT_DESIGN, DSS_CLR +3 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | drill_down_10 | 35 | 12764 | 7 | `s_m_dss_circuit_hierarchy_drill_down_10` |
| 2 | drill_down_2 | 35 | 12765 | 7 | `s_m_dss_circuit_hierarchy_drill_down_2` |
| 3 | drill_down_3 | 35 | 12766 | 7 | `s_m_dss_circuit_hierarchy_drill_down_3` |
| 4 | drill_down_4 | 35 | 12767 | 7 | `s_m_dss_circuit_hierarchy_drill_down_4` |
| 5 | drill_down_5 | 35 | 12768 | 7 | `s_m_dss_circuit_hierarchy_drill_down_5` |
| 6 | drill_down_6 | 35 | 12769 | 7 | `s_m_dss_circuit_hierarchy_drill_down_6` |
| 7 | drill_down_7 | 35 | 12770 | 7 | `s_m_dss_circuit_hierarchy_drill_down_7` |
| 8 | drill_down_8 | 35 | 12771 | 7 | `s_m_dss_circuit_hierarchy_drill_down_8` |
| 9 | drill_down_9 | 35 | 12772 | 7 | `s_m_dss_circuit_hierarchy_drill_down_9` |
| 10 | hierarchy_level_ones | 35 | 12773 | 6 | `s_m_dss_circuit_hierarchy_level_ones` |

#### DG_39 — 9 members
- **Sources:** `F_BILLING_ROLLUP, TMP_F_BILLING_ROLLUP`
- **Targets:** `F_BILLING_ROLLUP, F_BILLING_ROLLUP_EXT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | 3_AGGR_TAXMART | 10 | 9734 | 10 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_3_AGGR_TAXMART` |
| 2 | AGGR_TAXMART_0 | 10 | 9735 | 10 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_3_AGGR_TAXMART_0` |
| 3 | AGGR_TAXMART_01 | 10 | 9736 | 10 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_3_AGGR_TAXMART_01` |
| 4 | AGGR_TAXMART_02 | 10 | 9737 | 10 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_3_AGGR_TAXMART_02` |
| 5 | AGGR_TAXMART_03 | 10 | 9738 | 10 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_3_AGGR_TAXMART_03` |
| 6 | AGGR_TAXMART_04 | 10 | 9739 | 10 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_3_AGGR_TAXMART_04` |
| 7 | AGGR_TAXMART_05 | 10 | 9740 | 10 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_3_AGGR_TAXMART_05` |
| 8 | AGGR_TAXMART_06 | 10 | 9741 | 10 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_3_AGGR_TAXMART_06` |
| 9 | AGGR_TAXMART_07 | 10 | 9742 | 10 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_3_AGGR_TAXMART_07` |

#### DG_40 — 9 members
- **Sources:** `BILL_INVOICE, BILL_INVOICE1, DUAL, DUAL1, D_TAXMART_PERIOD`
- **Targets:** `FL_GENERATED_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ALLOCATION_MNTH_206 | 30 | 12048 | 11 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_206` |
| 2 | ALLOCATION_MNTH_242 | 30 | 12049 | 11 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_242` |
| 3 | ALLOCATION_MNTH_CBP | 30 | 12052 | 11 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_MNTH_CBP` |
| 4 | ALLOCATION_QRTR_206 | 30 | 12062 | 11 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_206` |
| 5 | ALLOCATION_QRTR_242 | 30 | 12063 | 11 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_242` |
| 6 | ALLOCATION_QRTR_CBP | 30 | 12067 | 11 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_QRTR_CBP` |
| 7 | ALLOCATION_YR_206 | 30 | 12077 | 11 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_206` |
| 8 | ALLOCATION_YR_242 | 30 | 12078 | 11 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_242` |
| 9 | ALLOCATION_YR_CBP | 30 | 12082 | 11 | `s_m_GENERATE_PARAMETERS_REVENUE_ALLOCATION_YR_CBP` |

#### DG_41 — 9 members
- **Sources:** `JOURNAL_HEADER, JOURNAL_LINE, NETEX_ACCRUAL_ALLOC`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, DSL_AIM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ALLOC_TAILS_EXPORT | 24 | 11222 | 11 | `s_m_Load_EMEA_NETEX_ALLOC_TAILS_EXPORT` |
| 2 | ALLOC_TAILS_EXPORT | 24 | 11225 | 11 | `s_m_Load_LATAM_NETEX_ALLOC_TAILS_EXPORT` |
| 3 | ALLOC_TAILS_EXPORT | 24 | 11277 | 11 | `s_m_Load_SAP_NETEX_ALLOC_TAILS_EXPORT` |
| 4 | TAILS_EXPORT_CTL | 24 | 11278 | 11 | `s_m_Load_SAP_NETEX_ALLOC_TAILS_EXPORT_CTL` |
| 5 | TAILS_EXPORT_LVLT | 24 | 11279 | 11 | `s_m_Load_SAP_NETEX_ALLOC_TAILS_EXPORT_LVLT` |
| 6 | ALLOC_USF_EXPORT | 24 | 11280 | 11 | `s_m_Load_SAP_NETEX_ALLOC_USF_EXPORT` |
| 7 | ALLOC_VOICE_EXPORT | 24 | 11281 | 11 | `s_m_Load_SAP_NETEX_ALLOC_VOICE_EXPORT` |
| 8 | ALLOC_VYVX_EXPORT | 24 | 11282 | 11 | `s_m_Load_SAP_NETEX_ALLOC_VYVX_EXPORT` |
| 9 | NETEX_ALLOC_EXPORT | 24 | 11291 | 14 | `s_m_Load_VOICE_NETEX_ALLOC_EXPORT` |

#### DG_42 — 9 members
- **Sources:** `DUMMY_SRC_DW_SEC_COM_NBR`
- **Targets:** `CRPL_CISCO_UCM, DUMMY_TGT_DW_SEC_COM_NBR`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CALL_TYPE_INTERVAL | 1 | 6916 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CALL_TYPE_INTERVAL` |
| 2 | CISCO_UCM_AGENT | 1 | 6917 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_CISCO_UCM_AGENT` |
| 3 | AGENT_EVENT_DETAIL | 1 | 6918 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_CISCO_UCM_AGENT_EVENT_DETAIL` |
| 4 | UCM_AGENT_LOGOUT | 1 | 6919 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_CISCO_UCM_AGENT_LOGOUT` |
| 5 | SKILL_GROUP_INTERVAL | 1 | 6920 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_CISCO_UCM_AGENT_SKILL_GROUP_INTERVAL` |
| 6 | UCM_AGENT_TEAM | 1 | 6921 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_CISCO_UCM_AGENT_TEAM` |
| 7 | CISCO_UCM_SERVICE | 1 | 6922 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_CISCO_UCM_SERVICE` |
| 8 | TERMINATION_CALL_DETAIL | 1 | 6923 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_CISCO_UCM_TERMINATION_CALL_DETAIL` |
| 9 | TERMINATION_CALL_VARIABLE | 1 | 6924 | 2 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_CISCO_UCM_TERMINATION_CALL_VARIABLE` |

#### DG_43 — 9 members
- **Sources:** `DUMMY_SRC`
- **Targets:** `TGT_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Compute_Stats_ENS | 1 | 577 | 3 | `s_m_Compute_Stats_ENS` |
| 2 | COS_CHARGE_STG | 1 | 578 | 3 | `s_m_Compute_Stats_ENS_COS_CHARGE_STG` |
| 3 | Stats_ENS_MM | 1 | 579 | 3 | `s_m_Compute_Stats_ENS_MM` |
| 4 | Metadata_ENS_MM | 1 | 663 | 3 | `s_m_Invalidate_Metadata_ENS_MM` |
| 5 | ORDER_STGGING_TABLE | 1 | 1571 | 3 | `s_m_Load_CIRCUIT_ORDER_STGGING_TABLE` |
| 6 | ASL_CABS_stg | 1 | 1982 | 3 | `s_m_Load_Compute_Stats_ASL_CABS_stg` |
| 7 | ASL_WDM_stg | 1 | 1983 | 3 | `s_m_Load_Compute_Stats_ASL_WDM_stg` |
| 8 | Load_STG_Table | 1 | 5321 | 3 | `s_m_Load_STG_Table` |
| 9 | Load_truncate_tables | 1 | 6708 | 3 | `s_m_Load_truncate_tables` |

#### DG_44 — 9 members
- **Sources:** `GFS_LAT_LONG_LKP`
- **Targets:** `FF_GFS_LAT_LONG_LKP, GFS_LAT_LONG_LKP, WFMIMP1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | HIST_New_1 | 1 | 6969 | 11 | `s_m_Update_GFS_LAT_LONG_LKP_HIST_New_1` |
| 2 | HIST_New_2 | 1 | 6970 | 11 | `s_m_Update_GFS_LAT_LONG_LKP_HIST_New_2` |
| 3 | HIST_New_3 | 1 | 6971 | 11 | `s_m_Update_GFS_LAT_LONG_LKP_HIST_New_3` |
| 4 | HIST_New_4 | 1 | 6972 | 11 | `s_m_Update_GFS_LAT_LONG_LKP_HIST_New_4` |
| 5 | HIST_New_5 | 1 | 6973 | 11 | `s_m_Update_GFS_LAT_LONG_LKP_HIST_New_5` |
| 6 | HIST_New_6 | 1 | 6974 | 11 | `s_m_Update_GFS_LAT_LONG_LKP_HIST_New_6` |
| 7 | HIST_New_7 | 1 | 6975 | 11 | `s_m_Update_GFS_LAT_LONG_LKP_HIST_New_7` |
| 8 | HIST_New_8 | 1 | 6976 | 11 | `s_m_Update_GFS_LAT_LONG_LKP_HIST_New_8` |
| 9 | HIST_New_9 | 1 | 6977 | 11 | `s_m_Update_GFS_LAT_LONG_LKP_HIST_New_9` |

#### DG_45 — 9 members
- **Sources:** `GFS_LAT_LONG_LKP`
- **Targets:** `GFS_LAT_LONG_LKP, WFMIMP1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LONG_LKP_HIST1 | 1 | 6960 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_HIST1` |
| 2 | LONG_LKP_HIST2 | 1 | 6961 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_HIST2` |
| 3 | LONG_LKP_HIST3 | 1 | 6962 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_HIST3` |
| 4 | LONG_LKP_HIST4 | 1 | 6963 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_HIST4` |
| 5 | LONG_LKP_HIST5 | 1 | 6964 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_HIST5` |
| 6 | LONG_LKP_HIST6 | 1 | 6965 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_HIST6` |
| 7 | LONG_LKP_HIST7 | 1 | 6966 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_HIST7` |
| 8 | LONG_LKP_HIST8 | 1 | 6967 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_HIST8` |
| 9 | LONG_LKP_HIST9 | 1 | 6968 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_HIST9` |

#### DG_46 — 9 members
- **Sources:** `PROCESS_PARAMETER`
- **Targets:** `CDW_COMMON, PROCESS_PARAMETER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NEW_MONTH_DASHBOARD | 1 | 615 | 3 | `s_m_Enable_NEW_MONTH_DASHBOARD` |
| 2 | DASHBOARD_VALUE_IND | 1 | 6895 | 3 | `s_m_Update_DASHBOARD_VALUE_IND` |
| 3 | ATTRIBUTES_Incr_Date | 1 | 6896 | 2 | `s_m_Update_DATAMKTP_CUSTOMER_ATTRIBUTES_Incr_Date` |
| 4 | OUTAGES_Incr_Date | 1 | 6897 | 2 | `s_m_Update_DATAMKTP_NETWORK_OUTAGES_Incr_Date` |
| 5 | PARAMETER_Incr_Date | 1 | 6898 | 2 | `s_m_Update_DATAMKTP_ORDERS_PROCESS_PARAMETER_Incr_Date` |
| 6 | Customer_Incr_Date | 1 | 6899 | 2 | `s_m_Update_DATAMKTP_REVENUE_BAN_Customer_Incr_Date` |
| 7 | REVENUE_Incr_Date | 1 | 6900 | 2 | `s_m_Update_DATAMKTP_REVENUE_Incr_Date` |
| 8 | Tier_Incr_Date | 1 | 6901 | 2 | `s_m_Update_DATAMKTP_REVENUE_Product_Tier_Incr_Date` |
| 9 | TICKETS_Incr_Date | 1 | 6902 | 2 | `s_m_Update_DATAMKTP_TROUBLE_TICKETS_Incr_Date` |

#### DG_47 — 9 members
- **Sources:** `PHYS_STRUCT_BUILDING`
- **Targets:** `PHYS_STRUCT_BUILDING, WFMIMP1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PHYS_STRUCT_BUILDING10 | 1 | 7006 | 10 | `s_m_Update_PHYS_STRUCT_BUILDING10` |
| 2 | PHYS_STRUCT_BUILDING11 | 1 | 7007 | 10 | `s_m_Update_PHYS_STRUCT_BUILDING11` |
| 3 | PHYS_STRUCT_BUILDING12 | 1 | 7008 | 10 | `s_m_Update_PHYS_STRUCT_BUILDING12` |
| 4 | PHYS_STRUCT_BUILDING4 | 1 | 7009 | 10 | `s_m_Update_PHYS_STRUCT_BUILDING4` |
| 5 | PHYS_STRUCT_BUILDING5 | 1 | 7010 | 10 | `s_m_Update_PHYS_STRUCT_BUILDING5` |
| 6 | PHYS_STRUCT_BUILDING6 | 1 | 7011 | 10 | `s_m_Update_PHYS_STRUCT_BUILDING6` |
| 7 | PHYS_STRUCT_BUILDING7 | 1 | 7012 | 10 | `s_m_Update_PHYS_STRUCT_BUILDING7` |
| 8 | PHYS_STRUCT_BUILDING8 | 1 | 7013 | 10 | `s_m_Update_PHYS_STRUCT_BUILDING8` |
| 9 | PHYS_STRUCT_BUILDING9 | 1 | 7014 | 10 | `s_m_Update_PHYS_STRUCT_BUILDING9` |

#### DG_48 — 9 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_QRTR, BILLED_REVENUE_TAX_VW_QRTR`
- **Targets:** `F_RVN_CTGRY_ALLCTN_PRCNT_QRTR`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_QRTR_007 | 1 | 74 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_007` |
| 2 | REVENUE_QRTR_100 | 1 | 75 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_100` |
| 3 | REVENUE_QRTR_125 | 1 | 76 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_125` |
| 4 | REVENUE_QRTR_131 | 1 | 77 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_131` |
| 5 | REVENUE_QRTR_133 | 1 | 78 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_133` |
| 6 | REVENUE_QRTR_206 | 1 | 82 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_206` |
| 7 | REVENUE_QRTR_242 | 1 | 83 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_242` |
| 8 | REVENUE_QRTR_624 | 1 | 85 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_624` |
| 9 | REVENUE_QRTR_S278 | 1 | 88 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_S278` |

#### DG_49 — 8 members
- **Sources:** `JRNL_DETL_FACT`
- **Targets:** `SWP_F_BILLING_DETAIL`
- **Lookups:** `BILLING_PRODUCT_COMPNT, CRTS_B242, CURRENCY_EXCHANGE_RATE, DH_BILLING_ACCOUNT, DH_GL_ACCOUNT +13 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_DETAIL_BILLING | 31 | 12318 | 24 | `s_m_Load_SWP_F_BILLING_DETAIL_BILLING` |
| 2 | BILLING_CURR_MNTH | 31 | 12319 | 24 | `s_m_Load_SWP_F_BILLING_DETAIL_BILLING_CURR_MNTH` |
| 3 | BILLING_NEXT_MNTH | 31 | 12320 | 24 | `s_m_Load_SWP_F_BILLING_DETAIL_BILLING_NEXT_MNTH` |
| 4 | DETAIL_NON_BILLING | 31 | 12321 | 24 | `s_m_Load_SWP_F_BILLING_DETAIL_NON_BILLING` |
| 5 | BILLING_CURR_MNTH | 31 | 12322 | 24 | `s_m_Load_SWP_F_BILLING_DETAIL_NON_BILLING_CURR_MNTH` |
| 6 | BILLING_NEXT_MNTH | 31 | 12323 | 24 | `s_m_Load_SWP_F_BILLING_DETAIL_NON_BILLING_NEXT_MNTH` |
| 7 | NONREVENUE_CURR_MNTH | 31 | 12324 | 24 | `s_m_Load_SWP_F_BILLING_DETAIL_NON_BILLING_NONREVENUE_CURR_MNTH` |
| 8 | NONREVENUE_NEXT_MNTH | 31 | 12325 | 24 | `s_m_Load_SWP_F_BILLING_DETAIL_NON_BILLING_NONREVENUE_NEXT_MNTH` |

#### DG_50 — 8 members
- **Sources:** `FF_VSUM4_DUMMY`
- **Targets:** `FF_JAVA_OUT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CDD_Unload_FACT | 1 | 12 | 3 | `s_m_4_CDD_Unload_FACT` |
| 2 | Unload_DIMS_CU | 1 | 17 | 3 | `s_m_4_CD_Unload_DIMS_CU` |
| 3 | Unload_DIMS_ID | 1 | 18 | 3 | `s_m_4_CD_Unload_DIMS_ID` |
| 4 | Unload_DIMS_NN | 1 | 19 | 3 | `s_m_4_CD_Unload_DIMS_NN` |
| 5 | Unload_DIMS_PA | 1 | 20 | 3 | `s_m_4_CD_Unload_DIMS_PA` |
| 6 | Unload_DIMS_SU | 1 | 21 | 3 | `s_m_4_CD_Unload_DIMS_SU` |
| 7 | Unload_DIMS_SW | 1 | 22 | 3 | `s_m_4_CD_Unload_DIMS_SW` |
| 8 | CD_Unload_FACT | 1 | 23 | 3 | `s_m_4_CD_Unload_FACT` |

#### DG_51 — 8 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, ORDER_PRODUCT_COMPNT, PRODUCT_COMPNT_INCR_AMT, PRODUCT_COMPNT_INCR_AMT1`
- **Targets:** `CODS, PRODUCT_COMPNT_INCR_AMT`
- **Lookups:** `CUSTOMER_ORDER, L3AR_GL_GOV_REV_VALUES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COMPNT_INCR_AMT | 6 | 9352 | 10 | `s_m_LOAD_CPO_PRODUCT_COMPNT_INCR_AMT` |
| 2 | COMPNT_INCR_AMT | 12 | 9944 | 9 | `s_m_LOAD_PROD_PRODUCT_COMPNT_INCR_AMT` |
| 3 | COMPNT_INCR_AMT | 12 | 9945 | 10 | `s_m_LOAD_SDP_PRODUCT_COMPNT_INCR_AMT` |
| 4 | COMPNT_INCR_AMT | 13 | 10050 | 9 | `s_m_Load_BM_PRODUCT_COMPNT_INCR_AMT` |
| 5 | COMPNT_INCR_AMT | 19 | 10616 | 9 | `s_m_Load_EASE_CABS_PRODUCT_COMPNT_INCR_AMT` |
| 6 | COMPNT_INCR_AMT | 19 | 10622 | 9 | `s_m_Load_ENS_MM_PRODUCT_COMPNT_INCR_AMT` |
| 7 | COMPNT_INCR_AMT | 23 | 11165 | 9 | `s_m_Load_QF_PRODUCT_COMPNT_INCR_AMT` |
| 8 | COMPNT_INCR_AMT | 29 | 11966 | 9 | `s_m_Load_VLOCITY_PRODUCT_COMPNT_INCR_AMT` |

#### DG_52 — 8 members
- **Sources:** `DUMMY_SRC_DW_SEC_COM_NBR`
- **Targets:** `CRPL_GCR, DUMMY_TGT_DW_SEC_COM_NBR`
- **Lookups:** `CLARIFY_SA`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CRPL_GCR_GCR | 5 | 9312 | 4 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_GCR` |
| 2 | GCR_TABLE_ADDRESS | 5 | 9313 | 4 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_ADDRESS` |
| 3 | GCR_TABLE_CASE | 5 | 9314 | 4 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_CASE` |
| 4 | GCR_TABLE_EMPLOYEE | 5 | 9315 | 4 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_EMPLOYEE` |
| 5 | TABLE_HGBST_ELM | 5 | 9316 | 4 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_HGBST_ELM` |
| 6 | GCR_TABLE_QUEUE | 5 | 9317 | 4 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_QUEUE` |
| 7 | GCR_TABLE_SITE | 5 | 9318 | 4 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_SITE` |
| 8 | GCR_TABLE_USER | 5 | 9319 | 4 | `s_m_Update_DW_SECURE_COMPANY_NBR_CRPL_GCR_TABLE_USER` |

#### DG_53 — 8 members
- **Sources:** `DUAL, DUAL_FAILSESSION1, FF_SLOB_ARCHIVE`
- **Targets:** `ACCESSCOMPONENT, APP_ERROR_LOG, DUAL, LOCATION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_ACCESSCOMPONENT_COLOCATION | 1 | 844 | 19 | `s_m_Load_ACCESSCOMPONENT_COLOCATION` |
| 2 | Load_ACCESSCOMPONENT_CPA | 1 | 845 | 19 | `s_m_Load_ACCESSCOMPONENT_CPA` |
| 3 | ETHER_EXTENDED_FIXED | 1 | 846 | 19 | `s_m_Load_ACCESSCOMPONENT_ETHER_EXTENDED_FIXED` |
| 4 | ACCESSCOMPONENT_EXTENDED_DEMARC | 1 | 847 | 19 | `s_m_Load_ACCESSCOMPONENT_EXTENDED_DEMARC` |
| 5 | Load_ACCESSCOMPONENT_HUB | 1 | 848 | 19 | `s_m_Load_ACCESSCOMPONENT_HUB` |
| 6 | Load_ACCESSCOMPONENT_ONNET | 1 | 849 | 19 | `s_m_Load_ACCESSCOMPONENT_ONNET` |
| 7 | Load_ACCESSCOMPONENT_THIRDPARTY | 1 | 850 | 18 | `s_m_Load_ACCESSCOMPONENT_THIRDPARTY` |
| 8 | ACCESS_COMPONENT_OFFNET | 1 | 851 | 19 | `s_m_Load_ACCESS_COMPONENT_OFFNET` |

#### DG_54 — 8 members
- **Sources:** `XBTPNE, XBTPNE2`
- **Targets:** `CNUM, XBTPNE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_XBTPNE_CNUMNE1A | 1 | 6557 | 11 | `s_m_Load_XBTPNE_CNUMNE1A` |
| 2 | Load_XBTPNE_CNUMNE1B | 1 | 6558 | 11 | `s_m_Load_XBTPNE_CNUMNE1B` |
| 3 | Load_XBTPNE_CNUMNE2A | 1 | 6559 | 11 | `s_m_Load_XBTPNE_CNUMNE2A` |
| 4 | Load_XBTPNE_CNUMNE2B | 1 | 6560 | 11 | `s_m_Load_XBTPNE_CNUMNE2B` |
| 5 | Load_XBTPNE_CNUMUT1A | 1 | 6561 | 11 | `s_m_Load_XBTPNE_CNUMUT1A` |
| 6 | Load_XBTPNE_CNUMUT1B | 1 | 6562 | 11 | `s_m_Load_XBTPNE_CNUMUT1B` |
| 7 | Load_XBTPNE_CNUMUT2A | 1 | 6563 | 11 | `s_m_Load_XBTPNE_CNUMUT2A` |
| 8 | Load_XBTPNE_CNUMUT2B | 1 | 6564 | 11 | `s_m_Load_XBTPNE_CNUMUT2B` |

#### DG_55 — 8 members
- **Sources:** `XBTPNUMBERHISTORY, XBTPNUMBERHISTORY2`
- **Targets:** `CNUM, XBTPNUMBERHISTORY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_XBTPNUMBERHISTORY_CNUMNE1A | 1 | 6566 | 11 | `s_m_Load_XBTPNUMBERHISTORY_CNUMNE1A` |
| 2 | Load_XBTPNUMBERHISTORY_CNUMNE1B | 1 | 6567 | 11 | `s_m_Load_XBTPNUMBERHISTORY_CNUMNE1B` |
| 3 | Load_XBTPNUMBERHISTORY_CNUMNE2A | 1 | 6568 | 11 | `s_m_Load_XBTPNUMBERHISTORY_CNUMNE2A` |
| 4 | Load_XBTPNUMBERHISTORY_CNUMNE2B | 1 | 6569 | 11 | `s_m_Load_XBTPNUMBERHISTORY_CNUMNE2B` |
| 5 | Load_XBTPNUMBERHISTORY_CNUMUT1A | 1 | 6570 | 11 | `s_m_Load_XBTPNUMBERHISTORY_CNUMUT1A` |
| 6 | Load_XBTPNUMBERHISTORY_CNUMUT1B | 1 | 6571 | 11 | `s_m_Load_XBTPNUMBERHISTORY_CNUMUT1B` |
| 7 | Load_XBTPNUMBERHISTORY_CNUMUT2A | 1 | 6572 | 11 | `s_m_Load_XBTPNUMBERHISTORY_CNUMUT2A` |
| 8 | Load_XBTPNUMBERHISTORY_CNUMUT2B | 1 | 6573 | 11 | `s_m_Load_XBTPNUMBERHISTORY_CNUMUT2B` |

#### DG_56 — 8 members
- **Sources:** `XBTPREMARK, XBTPREMARK2`
- **Targets:** `CNUM, XBTPREMARK`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_XBTPREMARK_CNUMNE1A | 1 | 6577 | 11 | `s_m_Load_XBTPREMARK_CNUMNE1A` |
| 2 | Load_XBTPREMARK_CNUMNE1B | 1 | 6578 | 11 | `s_m_Load_XBTPREMARK_CNUMNE1B` |
| 3 | Load_XBTPREMARK_CNUMNE2A | 1 | 6579 | 11 | `s_m_Load_XBTPREMARK_CNUMNE2A` |
| 4 | Load_XBTPREMARK_CNUMNE2B | 1 | 6580 | 11 | `s_m_Load_XBTPREMARK_CNUMNE2B` |
| 5 | Load_XBTPREMARK_CNUMUT1A | 1 | 6581 | 11 | `s_m_Load_XBTPREMARK_CNUMUT1A` |
| 6 | Load_XBTPREMARK_CNUMUT1B | 1 | 6582 | 11 | `s_m_Load_XBTPREMARK_CNUMUT1B` |
| 7 | Load_XBTPREMARK_CNUMUT2A | 1 | 6583 | 11 | `s_m_Load_XBTPREMARK_CNUMUT2A` |
| 8 | Load_XBTPREMARK_CNUMUT2B | 1 | 6584 | 11 | `s_m_Load_XBTPREMARK_CNUMUT2B` |

#### DG_57 — 8 members
- **Sources:** `XBTPSITE, XBTPSITE2, XBTPSITE_BKP, XBTPSITE_BKP1`
- **Targets:** `CNUM, XBTPSITE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_XBTPSITE_CNUMNE1A | 1 | 6585 | 11 | `s_m_Load_XBTPSITE_CNUMNE1A` |
| 2 | Load_XBTPSITE_CNUMNE1B | 1 | 6586 | 11 | `s_m_Load_XBTPSITE_CNUMNE1B` |
| 3 | Load_XBTPSITE_CNUMNE2A | 1 | 6587 | 11 | `s_m_Load_XBTPSITE_CNUMNE2A` |
| 4 | Load_XBTPSITE_CNUMNE2B | 1 | 6588 | 11 | `s_m_Load_XBTPSITE_CNUMNE2B` |
| 5 | Load_XBTPSITE_CNUMUT1A | 1 | 6589 | 11 | `s_m_Load_XBTPSITE_CNUMUT1A` |
| 6 | Load_XBTPSITE_CNUMUT1B | 1 | 6590 | 11 | `s_m_Load_XBTPSITE_CNUMUT1B` |
| 7 | Load_XBTPSITE_CNUMUT2A | 1 | 6591 | 11 | `s_m_Load_XBTPSITE_CNUMUT2A` |
| 8 | Load_XBTPSITE_CNUMUT2B | 1 | 6592 | 11 | `s_m_Load_XBTPSITE_CNUMUT2B` |

#### DG_58 — 8 members
- **Sources:** `XBTPTNAGING, XBTPTNAGING_SRC`
- **Targets:** `CNUM, XBTPTNAGING`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_XBTPTNAGING_CNUMNE1A | 1 | 6593 | 11 | `s_m_Load_XBTPTNAGING_CNUMNE1A` |
| 2 | Load_XBTPTNAGING_CNUMNE1B | 1 | 6594 | 11 | `s_m_Load_XBTPTNAGING_CNUMNE1B` |
| 3 | Load_XBTPTNAGING_CNUMNE2A | 1 | 6595 | 11 | `s_m_Load_XBTPTNAGING_CNUMNE2A` |
| 4 | Load_XBTPTNAGING_CNUMNE2B | 1 | 6596 | 11 | `s_m_Load_XBTPTNAGING_CNUMNE2B` |
| 5 | Load_XBTPTNAGING_CNUMUT1A | 1 | 6597 | 11 | `s_m_Load_XBTPTNAGING_CNUMUT1A` |
| 6 | Load_XBTPTNAGING_CNUMUT1B | 1 | 6598 | 11 | `s_m_Load_XBTPTNAGING_CNUMUT1B` |
| 7 | Load_XBTPTNAGING_CNUMUT2A | 1 | 6599 | 11 | `s_m_Load_XBTPTNAGING_CNUMUT2A` |
| 8 | Load_XBTPTNAGING_CNUMUT2B | 1 | 6600 | 11 | `s_m_Load_XBTPTNAGING_CNUMUT2B` |

#### DG_59 — 8 members
- **Sources:** `XBTPTNLNSVC, XBTPTNLNSVC2, XBTPTNLNSVC_SRC`
- **Targets:** `CNUM, XBTPTNLNSVC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_XBTPTNLNSVC_CNUMNE1A | 1 | 6601 | 11 | `s_m_Load_XBTPTNLNSVC_CNUMNE1A` |
| 2 | Load_XBTPTNLNSVC_CNUMNE1B | 1 | 6602 | 11 | `s_m_Load_XBTPTNLNSVC_CNUMNE1B` |
| 3 | Load_XBTPTNLNSVC_CNUMNE2A | 1 | 6603 | 11 | `s_m_Load_XBTPTNLNSVC_CNUMNE2A` |
| 4 | Load_XBTPTNLNSVC_CNUMNE2B | 1 | 6604 | 11 | `s_m_Load_XBTPTNLNSVC_CNUMNE2B` |
| 5 | Load_XBTPTNLNSVC_CNUMUT1A | 1 | 6605 | 11 | `s_m_Load_XBTPTNLNSVC_CNUMUT1A` |
| 6 | Load_XBTPTNLNSVC_CNUMUT1B | 1 | 6606 | 11 | `s_m_Load_XBTPTNLNSVC_CNUMUT1B` |
| 7 | Load_XBTPTNLNSVC_CNUMUT2A | 1 | 6607 | 11 | `s_m_Load_XBTPTNLNSVC_CNUMUT2A` |
| 8 | Load_XBTPTNLNSVC_CNUMUT2B | 1 | 6608 | 11 | `s_m_Load_XBTPTNLNSVC_CNUMUT2B` |

#### DG_60 — 8 members
- **Sources:** `XBTPTNNER, XBTPTNNER2`
- **Targets:** `CNUM, XBTPTNNER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_XBTPTNNER_CNUMNE1A | 1 | 6609 | 11 | `s_m_Load_XBTPTNNER_CNUMNE1A` |
| 2 | Load_XBTPTNNER_CNUMNE1B | 1 | 6610 | 11 | `s_m_Load_XBTPTNNER_CNUMNE1B` |
| 3 | Load_XBTPTNNER_CNUMNE2A | 1 | 6611 | 11 | `s_m_Load_XBTPTNNER_CNUMNE2A` |
| 4 | Load_XBTPTNNER_CNUMNE2B | 1 | 6612 | 11 | `s_m_Load_XBTPTNNER_CNUMNE2B` |
| 5 | Load_XBTPTNNER_CNUMUT1A | 1 | 6613 | 11 | `s_m_Load_XBTPTNNER_CNUMUT1A` |
| 6 | Load_XBTPTNNER_CNUMUT1B | 1 | 6614 | 11 | `s_m_Load_XBTPTNNER_CNUMUT1B` |
| 7 | Load_XBTPTNNER_CNUMUT2A | 1 | 6615 | 11 | `s_m_Load_XBTPTNNER_CNUMUT2A` |
| 8 | Load_XBTPTNNER_CNUMUT2B | 1 | 6616 | 11 | `s_m_Load_XBTPTNNER_CNUMUT2B` |

#### DG_61 — 8 members
- **Sources:** `XBTPTNRANGE, XBTPTNRANGE2`
- **Targets:** `CNUM, XBTPTNRANGE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_XBTPTNRANGE_CNUMNE1A | 1 | 6617 | 11 | `s_m_Load_XBTPTNRANGE_CNUMNE1A` |
| 2 | Load_XBTPTNRANGE_CNUMNE1B | 1 | 6618 | 11 | `s_m_Load_XBTPTNRANGE_CNUMNE1B` |
| 3 | Load_XBTPTNRANGE_CNUMNE2A | 1 | 6619 | 11 | `s_m_Load_XBTPTNRANGE_CNUMNE2A` |
| 4 | Load_XBTPTNRANGE_CNUMNE2B | 1 | 6620 | 11 | `s_m_Load_XBTPTNRANGE_CNUMNE2B` |
| 5 | Load_XBTPTNRANGE_CNUMUT1A | 1 | 6621 | 11 | `s_m_Load_XBTPTNRANGE_CNUMUT1A` |
| 6 | Load_XBTPTNRANGE_CNUMUT1B | 1 | 6622 | 11 | `s_m_Load_XBTPTNRANGE_CNUMUT1B` |
| 7 | Load_XBTPTNRANGE_CNUMUT2A | 1 | 6623 | 11 | `s_m_Load_XBTPTNRANGE_CNUMUT2A` |
| 8 | Load_XBTPTNRANGE_CNUMUT2B | 1 | 6624 | 11 | `s_m_Load_XBTPTNRANGE_CNUMUT2B` |

#### DG_62 — 8 members
- **Sources:** `XBTPTN, XBTPTN2`
- **Targets:** `CNUM, XBTPTN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_XBTPTN_CNUMNE1A | 1 | 6626 | 11 | `s_m_Load_XBTPTN_CNUMNE1A` |
| 2 | Load_XBTPTN_CNUMNE1B | 1 | 6627 | 11 | `s_m_Load_XBTPTN_CNUMNE1B` |
| 3 | Load_XBTPTN_CNUMNE2A | 1 | 6628 | 11 | `s_m_Load_XBTPTN_CNUMNE2A` |
| 4 | Load_XBTPTN_CNUMNE2B | 1 | 6629 | 11 | `s_m_Load_XBTPTN_CNUMNE2B` |
| 5 | Load_XBTPTN_CNUMUT1A | 1 | 6630 | 11 | `s_m_Load_XBTPTN_CNUMUT1A` |
| 6 | Load_XBTPTN_CNUMUT1B | 1 | 6631 | 11 | `s_m_Load_XBTPTN_CNUMUT1B` |
| 7 | Load_XBTPTN_CNUMUT2A | 1 | 6632 | 11 | `s_m_Load_XBTPTN_CNUMUT2A` |
| 8 | Load_XBTPTN_CNUMUT2B | 1 | 6633 | 11 | `s_m_Load_XBTPTN_CNUMUT2B` |

#### DG_63 — 8 members
- **Sources:** `ACCRUAL_CHARGE, ACCRUAL_CHARGE_MJE_EXPORT_SAP`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, DSL_AIM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SAP_LOAD_APAC | 23 | 11114 | 20 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LOAD_APAC` |
| 2 | LOAD_APAC_CTL | 23 | 11115 | 22 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LOAD_APAC_CTL` |
| 3 | SAP_LOAD_EMEA | 23 | 11116 | 20 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LOAD_EMEA` |
| 4 | LOAD_EMEA_CTL | 23 | 11117 | 22 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LOAD_EMEA_CTL` |
| 5 | SAP_LOAD_LATAM | 23 | 11118 | 20 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LOAD_LATAM` |
| 6 | LOAD_LATAM_CTL | 23 | 11119 | 22 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LOAD_LATAM_CTL` |
| 7 | SAP_LOAD_NA | 23 | 11120 | 20 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LOAD_NA` |
| 8 | LOAD_NA_CTL | 23 | 11121 | 22 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LOAD_NA_CTL` |

#### DG_64 — 8 members
- **Sources:** `DUMMY_SRC`
- **Targets:** `ASLNTFLX, STG_WAVELENGTH_HIERARCHY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STG_WAVELENGTH_HIERARCHY | 1 | 5324 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY` |
| 2 | STG_WAVELENGTH_HIERARCHY1 | 1 | 5325 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY1` |
| 3 | STG_WAVELENGTH_HIERARCHY11 | 1 | 5326 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY11` |
| 4 | STG_WAVELENGTH_HIERARCHY4 | 1 | 5327 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY4` |
| 5 | STG_WAVELENGTH_HIERARCHY5 | 1 | 5328 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY5` |
| 6 | STG_WAVELENGTH_HIERARCHY6 | 1 | 5329 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY6` |
| 7 | STG_WAVELENGTH_HIERARCHY7 | 1 | 5330 | 17 | `s_m_Load_STG_WAVELENGTH_HIERARCHY7` |
| 8 | STG_WAVELENGTH_HIERARCHY | 1 | 7531 | 17 | `s_m_load_STG_WAVELENGTH_HIERARCHY` |

#### DG_65 — 8 members
- **Sources:** `PHYS_STRUCT, SITE_INST`
- **Targets:** `CODS_NETINV, PHYS_STRUCT`
- **Lookups:** `PHYS_STRUCT, PHYS_STRUCT_CLLI_LIST`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STRUCT_PRO_COLO | 2 | 7921 | 10 | `s_m_LOAD_PHYS_STRUCT_PRO_COLO` |
| 2 | STRUCT_PRO_AISLE | 22 | 11033 | 10 | `s_m_Load_PHYS_STRUCT_PRO_AISLE` |
| 3 | STRUCT_PRO_BAY | 22 | 11034 | 10 | `s_m_Load_PHYS_STRUCT_PRO_BAY` |
| 4 | STRUCT_PRO_CUSTOMER | 22 | 11035 | 10 | `s_m_Load_PHYS_STRUCT_PRO_CUSTOMER` |
| 5 | CUSTOMER_POP_DEMARC | 22 | 11036 | 10 | `s_m_Load_PHYS_STRUCT_PRO_CUSTOMER_POP_DEMARC` |
| 6 | STRUCT_PRO_FLOOR | 22 | 11037 | 10 | `s_m_Load_PHYS_STRUCT_PRO_FLOOR` |
| 7 | STRUCT_PRO_ROOM | 22 | 11038 | 10 | `s_m_Load_PHYS_STRUCT_PRO_ROOM` |
| 8 | STRUCT_PRO_SUITE | 22 | 11039 | 10 | `s_m_Load_PHYS_STRUCT_PRO_SUITE` |

#### DG_66 — 8 members
- **Sources:** `AE2E_UNIX_JOB_LOG`
- **Targets:** `AE2E_UNIX_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | UNIX_LOG_UPD | 1 | 672 | 2 | `s_m_LOAD_AE2E_ASR_PON_UNIX_LOG_UPD` |
| 2 | JOB_LOG_UPD | 1 | 683 | 1 | `s_m_LOAD_AE2E_NEW_GETS_UNIX_JOB_LOG_UPD` |
| 3 | UNIX_JOB_BWXLINKCV | 1 | 690 | 1 | `s_m_LOAD_AE2E_UNIX_JOB_BWXLINKCV` |
| 4 | UNIX_JOB_LOG | 1 | 706 | 1 | `s_m_LOAD_CFY_UNIX_JOB_LOG` |
| 5 | UNIX_JOB_LOG | 1 | 776 | 1 | `s_m_LOAD_LCCI_UNIX_JOB_LOG` |
| 6 | JOB_LOG_UPD | 1 | 780 | 1 | `s_m_LOAD_NG_AE2E_UNIX_JOB_LOG_UPD` |
| 7 | UNIX_JOB_LOG | 1 | 828 | 2 | `s_m_LOAD_TGRS_UNIX_JOB_LOG` |
| 8 | UNIX_JOB_LOG | 1 | 837 | 2 | `s_m_LOAD_WILTEL_UNIX_JOB_LOG` |

#### DG_67 — 8 members
- **Sources:** `PARTITION_EXCH_CONTROL`
- **Targets:** `PARAMETER_FILE`
- **Lookups:** `PART_INFO`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | vero_merged_files | 2 | 7819 | 3 | `s_m_Gen_Dyn_Param_vero_merged_files` |
| 2 | Parameter_File_exch | 2 | 7820 | 3 | `s_m_Gen_Dynamic_Parameter_File_exch` |
| 3 | Parameter_File_kenanidc | 2 | 7821 | 3 | `s_m_Gen_Dynamic_Parameter_File_kenanidc` |
| 4 | File_part_exch | 2 | 7822 | 3 | `s_m_Gen_Dynamic_Parameter_File_part_exch` |
| 5 | Parameter_File_postcorr | 2 | 7823 | 3 | `s_m_Gen_Dynamic_Parameter_File_postcorr` |
| 6 | Parameter_File_postcorrstop | 2 | 7824 | 3 | `s_m_Gen_Dynamic_Parameter_File_postcorrstop` |
| 7 | Parameter_File_up | 2 | 7825 | 3 | `s_m_Gen_Dynamic_Parameter_File_up` |
| 8 | upd_proc_control | 2 | 7826 | 3 | `s_m_Gen_Dynamic_Parameter_File_upd_proc_control` |

#### DG_68 — 7 members
- **Sources:** `LINE_ITEM, LINE_ITEM_DTL, LINE_ITEM_JUR_DTL`
- **Targets:** `USOC_BILLED`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, VVREF`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ACCT_Initial_Load | 21 | 10859 | 6 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_ACCT_Initial_Load` |
| 2 | ASG_Initial_Load | 21 | 10861 | 6 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_ASG_Initial_Load` |
| 3 | BATCH1_Initial_Load | 21 | 10862 | 6 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_CKT_BATCH1_Initial_Load` |
| 4 | BATCH2_Initial_Load | 21 | 10863 | 6 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_CKT_BATCH2_Initial_Load` |
| 5 | BATCH3_Initial_Load | 21 | 10864 | 6 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_CKT_BATCH3_Initial_Load` |
| 6 | BATCH4_Initial_Load | 21 | 10865 | 6 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_CKT_BATCH4_Initial_Load` |
| 7 | BATCH5_Initial_Load | 21 | 10866 | 6 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_CKT_BATCH5_Initial_Load` |

#### DG_69 — 7 members
- **Sources:** `PROCESS_PARAMETER`
- **Targets:** `FF_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ALL_ERT_SUM | 15 | 10257 | 4 | `s_m_Load_TMP_ALL_ERT_SUM` |
| 2 | ALL_FPE_SUM | 15 | 10258 | 4 | `s_m_Load_TMP_ALL_FPE_SUM` |
| 3 | ALL_GLBA_SUM | 15 | 10259 | 4 | `s_m_Load_TMP_ALL_GLBA_SUM` |
| 4 | ALL_GOAT_SUM | 15 | 10260 | 4 | `s_m_Load_TMP_ALL_GOAT_SUM` |
| 5 | REV_FRD_SUM | 15 | 10262 | 4 | `s_m_Load_TMP_REV_FRD_SUM` |
| 6 | REV_GOAT_SUM | 15 | 10263 | 4 | `s_m_Load_TMP_REV_GOAT_SUM` |
| 7 | REV_ORAFIN_SUM | 15 | 10264 | 4 | `s_m_Load_TMP_REV_ORAFIN_SUM` |

#### DG_70 — 7 members
- **Sources:** `ASL_LOAD_STATUS`
- **Targets:** `FF_PARAMETER_FILE`
- **Lookups:** `ETL_PARAMETER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BACKDATED_RUN_FBR | 5 | 9191 | 9 | `s_m_GENERATE_PARAMETER_BACKDATED_RUN_FBR` |
| 2 | INITIAL_CURR_MONTH | 5 | 9193 | 9 | `s_m_GENERATE_PARAMETER_FILE_INITIAL_CURR_MONTH` |
| 3 | INITIAL_PREV_MONTH | 5 | 9194 | 9 | `s_m_GENERATE_PARAMETER_FILE_INITIAL_PREV_MONTH` |
| 4 | PREV_MONTH_CABS | 5 | 9195 | 9 | `s_m_GENERATE_PARAMETER_FILE_INITIAL_PREV_MONTH_CABS` |
| 5 | LEGACY_CTL_CABS | 5 | 9196 | 9 | `s_m_GENERATE_PARAMETER_FILE_LEGACY_CTL_CABS` |
| 6 | LEGACY_CTL_ENS | 5 | 9197 | 9 | `s_m_GENERATE_PARAMETER_FILE_LEGACY_CTL_ENS` |
| 7 | LEGACY_CTL_LATIS | 5 | 9198 | 9 | `s_m_GENERATE_PARAMETER_FILE_LEGACY_CTL_LATIS` |

#### DG_71 — 7 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP`
- **Targets:** `ACCRUAL_USAGE_EXPORT_SAP_FF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CALL_CENTER_FF | 27 | 11565 | 5 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_CALL_CENTER_FF` |
| 2 | SAP_CAM_FF | 27 | 11566 | 5 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_CAM_FF` |
| 3 | SAP_CDNA_FF | 27 | 11567 | 4 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_CDNA_FF` |
| 4 | SAP_COLLAB_FF | 27 | 11568 | 5 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_COLLAB_FF` |
| 5 | SAP_IVT_FF | 27 | 11569 | 5 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_IVT_FF` |
| 6 | SAP_LEXM_FF | 27 | 11570 | 4 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_LEXM_FF` |
| 7 | SAP_VSUM_FF | 27 | 11571 | 5 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_VSUM_FF` |

#### DG_72 — 7 members
- **Sources:** `ACCRUAL_CHARGE, ACCRUAL_CHARGE_MJE_EXPORT_SAP`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, DSL_AIM`
- **Lookups:** `GL_COMPANY`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | EXPORT_SAP_CTL | 23 | 11102 | 20 | `s_m_Load_ACCRUAL_CHARGE_DETAIL_MJE_EXPORT_SAP_CTL` |
| 2 | CTL_EMEA_DIVESTITURE | 23 | 11103 | 20 | `s_m_Load_ACCRUAL_CHARGE_DETAIL_MJE_EXPORT_SAP_CTL_EMEA_DIVESTITURE` |
| 3 | SAP_EMEA_DIVESTITURE | 23 | 11104 | 21 | `s_m_Load_ACCRUAL_CHARGE_DETAIL_MJE_EXPORT_SAP_EMEA_DIVESTITURE` |
| 4 | SAP_LATAM_DIVESTITURE | 23 | 11105 | 21 | `s_m_Load_ACCRUAL_CHARGE_DETAIL_MJE_EXPORT_SAP_LATAM_DIVESTITURE` |
| 5 | CTL_EMEA_DIVESTITURE | 23 | 11111 | 23 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_CTL_EMEA_DIVESTITURE` |
| 6 | SAP_EMEA_DIVESTITURE | 23 | 11112 | 21 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_EMEA_DIVESTITURE` |
| 7 | SAP_LATAM_DIVESTITURE | 23 | 11113 | 21 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LATAM_DIVESTITURE` |

#### DG_73 — 7 members
- **Sources:** `DUMMY_SRCE`
- **Targets:** `DUMMY_TGT4`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | IDS_KENAN_ONETIME | 1 | 127 | 2 | `s_m_CORRECT_KEY_IDS_KENAN_ONETIME` |
| 2 | ENS_PLUS_Data | 1 | 547 | 1 | `s_m_Check_ENS_PLUS_Data` |
| 3 | ACCOUNT_ALL_FO | 1 | 2130 | 4 | `s_m_Load_D_BILLING_ACCOUNT_ALL_FO` |
| 4 | CUST_REVENUE_SALES | 1 | 5413 | 5 | `s_m_Load_SWP_AVG_CUST_REVENUE_SALES` |
| 5 | BILLING_ACCOUNT_ALL | 1 | 5416 | 11 | `s_m_Load_SWP_D_BILLING_ACCOUNT_ALL` |
| 6 | MEC_DSL_FINANCE | 1 | 6710 | 2 | `s_m_MEC_DSL_FINANCE` |
| 7 | ONETIME_HISTORY_CORRECTION | 1 | 6740 | 2 | `s_m_ONETIME_HISTORY_CORRECTION` |

#### DG_74 — 7 members
- **Sources:** `SRC_TID`
- **Targets:** `ASLNTFLX, STG_ODU_CRS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_ODU_CRS2 | 1 | 3725 | 10 | `s_m_Load_ODU_CRS2` |
| 2 | ODU_CRS_TID2 | 1 | 3727 | 10 | `s_m_Load_ODU_CRS_TID2` |
| 3 | ODU_CRS_TID3 | 1 | 3728 | 10 | `s_m_Load_ODU_CRS_TID3` |
| 4 | ODU_CRS_TID4 | 1 | 3729 | 10 | `s_m_Load_ODU_CRS_TID4` |
| 5 | ODU_CRS_TID5 | 1 | 3730 | 10 | `s_m_Load_ODU_CRS_TID5` |
| 6 | ODU_CRS_tid6 | 1 | 3731 | 10 | `s_m_Load_ODU_CRS_tid6` |
| 7 | ODU_CRS_tid7 | 1 | 3732 | 10 | `s_m_Load_ODU_CRS_tid7` |

#### DG_75 — 7 members
- **Sources:** `SRC_TID`
- **Targets:** `ASLNTFLX, STG_WAVELENGTH_CARRIER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_WAVELENGTH_CARRIER1 | 1 | 6414 | 9 | `s_m_Load_WAVELENGTH_CARRIER1` |
| 2 | Load_WAVELENGTH_CARRIER11 | 1 | 6415 | 9 | `s_m_Load_WAVELENGTH_CARRIER11` |
| 3 | Load_WAVELENGTH_CARRIER2 | 1 | 6416 | 9 | `s_m_Load_WAVELENGTH_CARRIER2` |
| 4 | Load_WAVELENGTH_CARRIER4 | 1 | 6417 | 9 | `s_m_Load_WAVELENGTH_CARRIER4` |
| 5 | Load_WAVELENGTH_CARRIER5 | 1 | 6418 | 9 | `s_m_Load_WAVELENGTH_CARRIER5` |
| 6 | Load_WAVELENGTH_CARRIER6 | 1 | 6419 | 9 | `s_m_Load_WAVELENGTH_CARRIER6` |
| 7 | Load_WAVELENGTH_CARRIER7 | 1 | 6420 | 9 | `s_m_Load_WAVELENGTH_CARRIER7` |

#### DG_76 — 7 members
- **Sources:** `SRC_TID, SRC_TID1`
- **Targets:** `ASLNTFLX, STG_WAVELENGTH_CLIENT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_WAVELENGTH_CLIENT1 | 1 | 6422 | 9 | `s_m_Load_WAVELENGTH_CLIENT1` |
| 2 | Load_WAVELENGTH_CLIENT11 | 1 | 6423 | 9 | `s_m_Load_WAVELENGTH_CLIENT11` |
| 3 | Load_WAVELENGTH_CLIENT2 | 1 | 6424 | 9 | `s_m_Load_WAVELENGTH_CLIENT2` |
| 4 | Load_WAVELENGTH_CLIENT4 | 1 | 6425 | 9 | `s_m_Load_WAVELENGTH_CLIENT4` |
| 5 | Load_WAVELENGTH_CLIENT5 | 1 | 6426 | 9 | `s_m_Load_WAVELENGTH_CLIENT5` |
| 6 | Load_WAVELENGTH_CLIENT6 | 1 | 6427 | 9 | `s_m_Load_WAVELENGTH_CLIENT6` |
| 7 | Load_WAVELENGTH_CLIENT7 | 1 | 6428 | 9 | `s_m_Load_WAVELENGTH_CLIENT7` |

#### DG_77 — 7 members
- **Sources:** `DUMMY_SRC, DUMMY_SRC11`
- **Targets:** `ASLNTFLX, STG_MANAGED_ELEMENT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MANAGED_ELEMENT_STG | 1 | 3598 | 23 | `s_m_Load_NETFLEX_MANAGED_ELEMENT_STG` |
| 2 | MANAGED_ELEMENT_STG1 | 1 | 3599 | 23 | `s_m_Load_NETFLEX_MANAGED_ELEMENT_STG1` |
| 3 | MANAGED_ELEMENT_STG11 | 1 | 3600 | 23 | `s_m_Load_NETFLEX_MANAGED_ELEMENT_STG11` |
| 4 | MANAGED_ELEMENT_STG4 | 1 | 3601 | 23 | `s_m_Load_NETFLEX_MANAGED_ELEMENT_STG4` |
| 5 | MANAGED_ELEMENT_STG5 | 1 | 3602 | 23 | `s_m_Load_NETFLEX_MANAGED_ELEMENT_STG5` |
| 6 | MANAGED_ELEMENT_STG6 | 1 | 3603 | 23 | `s_m_Load_NETFLEX_MANAGED_ELEMENT_STG6` |
| 7 | MANAGED_ELEMENT_STG7 | 1 | 3604 | 23 | `s_m_Load_NETFLEX_MANAGED_ELEMENT_STG7` |

#### DG_78 — 7 members
- **Sources:** `MLSN, MLSN1, SRC_TID, SRC_TOPOLOGY`
- **Targets:** `ASLNTFLX, MLSN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MLSN_NOKIA1830_TID1 | 1 | 3489 | 22 | `s_m_Load_MLSN_NOKIA1830_TID1` |
| 2 | MLSN_NOKIA1830_TID2 | 1 | 3490 | 22 | `s_m_Load_MLSN_NOKIA1830_TID2` |
| 3 | MLSN_NOKIA1830_TID3 | 1 | 3491 | 22 | `s_m_Load_MLSN_NOKIA1830_TID3` |
| 4 | MLSN_NOKIA1830_TID4 | 1 | 3492 | 22 | `s_m_Load_MLSN_NOKIA1830_TID4` |
| 5 | MLSN_NOKIA1830_TID5 | 1 | 3493 | 22 | `s_m_Load_MLSN_NOKIA1830_TID5` |
| 6 | MLSN_NOKIA1830_TID6 | 1 | 3494 | 22 | `s_m_Load_MLSN_NOKIA1830_TID6` |
| 7 | MLSN_NOKIA1830_TID7 | 1 | 3495 | 22 | `s_m_Load_MLSN_NOKIA1830_TID7` |

#### DG_79 — 7 members
- **Sources:** `USOC_BILLED`
- **Targets:** `CODS_NETEX, USOC_BILLED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETEX_USOC_BILLED | 1 | 6879 | 2 | `s_m_Upd_NETEX_USOC_BILLED` |
| 2 | USOC_BILLED_CTL | 1 | 6880 | 2 | `s_m_Upd_NETEX_USOC_BILLED_CTL` |
| 3 | BILLED_SAM_LATAM | 1 | 6883 | 2 | `s_m_Upd_NETEX_USOC_BILLED_SAM_LATAM` |
| 4 | SID_ODS_ID | 1 | 7031 | 3 | `s_m_Update_SID_ODS_ID` |
| 5 | ODS_ID_CTL | 1 | 7032 | 3 | `s_m_Update_SID_ODS_ID_CTL` |
| 6 | ID_SAM_LATAM | 1 | 7035 | 3 | `s_m_Update_SID_ODS_ID_SAM_LATAM` |
| 7 | BILLED_onetime_upd | 1 | 7537 | 3 | `s_m_load_USOC_BILLED_onetime_upd` |

#### DG_80 — 7 members
- **Sources:** `F_BILLING_ROLLUP, F_BILLING_ROLLUP1`
- **Targets:** `DUMMY_TGT, F_BILLED_REVENUE_MNTH`
- **Lookups:** `CCAT_EIS_CHARGE_ELIGIBLITY, F_FEDERAL_TAX_EXEMPTIONS, STATE_VALUES, U_CHARGE_ID_MAP, U_TAX_TYPE_CODE_MAP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_MNTH_100 | 16 | 10285 | 28 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_100` |
| 2 | REVENUE_MNTH_131 | 16 | 10287 | 28 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_131` |
| 3 | REVENUE_MNTH_169 | 16 | 10290 | 28 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_169` |
| 4 | REVENUE_MNTH_175 | 16 | 10291 | 28 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_175` |
| 5 | REVENUE_MNTH_641 | 16 | 10296 | 27 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_641` |
| 6 | REVENUE_MNTH_CBP | 16 | 10297 | 29 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_CBP` |
| 7 | REVENUE_MNTH_S278 | 16 | 10298 | 28 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_S278` |

#### DG_81 — 7 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, ACCRUAL_USAGE`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, DSL_AIM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SAP_CALL_CENTER | 26 | 11483 | 9 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_CALL_CENTER` |
| 2 | EXPORT_SAP_CAM | 26 | 11484 | 9 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_CAM` |
| 3 | EXPORT_SAP_CDNA | 26 | 11485 | 9 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_CDNA` |
| 4 | EXPORT_SAP_COLLAB | 26 | 11486 | 9 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_COLLAB` |
| 5 | EXPORT_SAP_IVT | 26 | 11487 | 9 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_IVT` |
| 6 | EXPORT_SAP_LEXM | 26 | 11488 | 9 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_LEXM` |
| 7 | EXPORT_SAP_VSUM | 26 | 11489 | 9 | `s_m_Load_ACCRUAL_USAGE_MJE_EXPORT_SAP_VSUM` |

#### DG_82 — 7 members
- **Sources:** `SOURCE_CONTACT_ROLE`
- **Targets:** `CODS, SOURCE_CONTACT_ROLE`
- **Lookups:** `CUSTOMER_ORDER, LKP_CUSTOMER_ORDER, SOURCE_CONTACT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SOURCE_CONTACT_ROLE | 17 | 10469 | 9 | `s_m_Load_EASE_CABS_SOURCE_CONTACT_ROLE` |
| 2 | SOURCE_CONTACT_ROLE | 17 | 10473 | 9 | `s_m_Load_ENS_SOURCE_CONTACT_ROLE` |
| 3 | SOURCE_CONTACT_ROLE | 21 | 10881 | 10 | `s_m_Load_NETWORX_SOURCE_CONTACT_ROLE` |
| 4 | SOURCE_CONTACT_ROLE | 21 | 10897 | 7 | `s_m_Load_PROD_SOURCE_CONTACT_ROLE` |
| 5 | SOURCE_CONTACT_ROLE | 24 | 11284 | 9 | `s_m_Load_SDP_SOURCE_CONTACT_ROLE` |
| 6 | SOURCE_CONTACT_ROLE | 27 | 11634 | 9 | `s_m_Load_SWIFT_SOURCE_CONTACT_ROLE` |
| 7 | SOURCE_CONTACT_ROLE | 27 | 11637 | 9 | `s_m_Load_VANTIVE_SOURCE_CONTACT_ROLE` |

#### DG_83 — 7 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP_ADJ`
- **Lookups:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TAILS_AMT_ADJ | 27 | 11573 | 4 | `s_m_Load_EMEA_NETEX_ALLOC_TAILS_AMT_ADJ` |
| 2 | TAILS_AMT_ADJ | 27 | 11596 | 4 | `s_m_Load_SAP_NETEX_ALLOC_TAILS_AMT_ADJ` |
| 3 | AMT_ADJ_CTL | 27 | 11597 | 4 | `s_m_Load_SAP_NETEX_ALLOC_TAILS_AMT_ADJ_CTL` |
| 4 | AMT_ADJ_LVLT | 27 | 11598 | 4 | `s_m_Load_SAP_NETEX_ALLOC_TAILS_AMT_ADJ_LVLT` |
| 5 | USF_AMT_ADJ | 27 | 11600 | 4 | `s_m_Load_SAP_NETEX_ALLOC_USF_AMT_ADJ` |
| 6 | VOICE_AMT_ADJ | 27 | 11602 | 4 | `s_m_Load_SAP_NETEX_ALLOC_VOICE_AMT_ADJ` |
| 7 | VYVX_AMT_ADJ | 27 | 11604 | 4 | `s_m_Load_SAP_NETEX_ALLOC_VYVX_AMT_ADJ` |

#### DG_84 — 7 members
- **Sources:** `SRC_TID, SRC_TOPOLOGY, TOPOLOGY, TOPOLOGY1`
- **Targets:** `ASLNTFLX, TOPOLOGY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TOPOLOGY_NOKIA1830_TID1 | 1 | 6174 | 14 | `s_m_Load_TOPOLOGY_NOKIA1830_TID1` |
| 2 | TOPOLOGY_NOKIA1830_TID2 | 1 | 6175 | 14 | `s_m_Load_TOPOLOGY_NOKIA1830_TID2` |
| 3 | TOPOLOGY_NOKIA1830_TID3 | 1 | 6176 | 14 | `s_m_Load_TOPOLOGY_NOKIA1830_TID3` |
| 4 | TOPOLOGY_NOKIA1830_TID4 | 1 | 6177 | 14 | `s_m_Load_TOPOLOGY_NOKIA1830_TID4` |
| 5 | TOPOLOGY_NOKIA1830_TID5 | 1 | 6178 | 14 | `s_m_Load_TOPOLOGY_NOKIA1830_TID5` |
| 6 | TOPOLOGY_NOKIA1830_TID6 | 1 | 6179 | 14 | `s_m_Load_TOPOLOGY_NOKIA1830_TID6` |
| 7 | TOPOLOGY_NOKIA1830_TID7 | 1 | 6180 | 14 | `s_m_Load_TOPOLOGY_NOKIA1830_TID7` |

#### DG_85 — 6 members
- **Sources:** `M_VSUM_PROCESS_CONTROL`
- **Targets:** `M_VSUM_PROCESS_CONTROL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | 4_CDD_Police | 1 | 11 | 4 | `s_m_4_CDD_Police` |
| 2 | Upd_CT_post | 1 | 13 | 3 | `s_m_4_CDD_Upd_CT_post` |
| 3 | Upd_CT_pre | 1 | 14 | 3 | `s_m_4_CDD_Upd_CT_pre` |
| 4 | 4_CD_Police | 1 | 16 | 4 | `s_m_4_CD_Police` |
| 5 | Upd_CT_post | 1 | 24 | 3 | `s_m_4_CD_Upd_CT_post` |
| 6 | Upd_CT_pre | 1 | 25 | 3 | `s_m_4_CD_Upd_CT_pre` |

#### DG_86 — 6 members
- **Sources:** `F_BILLING_ROLLUP`
- **Targets:** `F_BILLING_ROLLUP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ANALYZE_FBR | 1 | 29 | 2 | `s_m_ANALYZE_FBR` |
| 2 | ANALYZE_FBR_EXT | 1 | 30 | 2 | `s_m_ANALYZE_FBR_EXT` |
| 3 | LOAD_FBR_DUMMY | 1 | 734 | 2 | `s_m_LOAD_FBR_DUMMY` |
| 4 | FBR_DUMMY_1 | 1 | 735 | 2 | `s_m_LOAD_FBR_DUMMY_1` |
| 5 | DUMMY_ANALYZE_TMP | 1 | 736 | 2 | `s_m_LOAD_FBR_DUMMY_ANALYZE_TMP` |
| 6 | DUMMY_TRUNC_TMP | 1 | 737 | 2 | `s_m_LOAD_FBR_DUMMY_TRUNC_TMP` |

#### DG_87 — 6 members
- **Sources:** `CIRCUIT_DETAIL, SUPPLIER_CIRCUIT`
- **Targets:** `CODS_NETEX_STG, STG_CIRCUIT_ASG_TSC_ALLOC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASG_ALLOC_SAM | 17 | 10495 | 12 | `s_m_Load_NETEX_STG_CIRCUIT_ASG_ALLOC_SAM` |
| 2 | ALLOC_SAM_EMEA | 17 | 10496 | 12 | `s_m_Load_NETEX_STG_CIRCUIT_ASG_ALLOC_SAM_EMEA` |
| 3 | ALLOC_SAM_LATAM | 17 | 10497 | 12 | `s_m_Load_NETEX_STG_CIRCUIT_ASG_ALLOC_SAM_LATAM` |
| 4 | TSC_ALLOC_SAM | 17 | 10498 | 10 | `s_m_Load_NETEX_STG_CIRCUIT_TSC_ALLOC_SAM` |
| 5 | ALLOC_SAM_EMEA | 17 | 10499 | 10 | `s_m_Load_NETEX_STG_CIRCUIT_TSC_ALLOC_SAM_EMEA` |
| 6 | ALLOC_SAM_LATAM | 17 | 10500 | 10 | `s_m_Load_NETEX_STG_CIRCUIT_TSC_ALLOC_SAM_LATAM` |

#### DG_88 — 6 members
- **Sources:** `AE2E_AM_OFFNET_MGR_PREP, AE2E_AM_OFFNET_MGR_PREP2, AE2E_BTP_STG3, AE2E_BTP_STG33, AE2E_JOB_LOG`
- **Targets:** `AE2E_AM_BILLTRACK_PRO_PREP, AE2E_JOB_LOG`
- **Lookups:** `AE2E_AM_BILLTRACK_PRO_PREP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLTRACK_PRO_PREP | 37 | 12855 | 7 | `s_m_LOAD_AE2E_BILLTRACK_PRO_PREP` |
| 2 | PRO_PREP_WCD | 37 | 12856 | 7 | `s_m_LOAD_AE2E_BILLTRACK_PRO_PREP_WCD` |
| 3 | PRO_PREP_WND | 37 | 12857 | 7 | `s_m_LOAD_AE2E_BILLTRACK_PRO_PREP_WND` |
| 4 | PRO_PREP_WNI | 37 | 12858 | 7 | `s_m_LOAD_AE2E_BILLTRACK_PRO_PREP_WNI` |
| 5 | BTP_PREP_FGDD | 37 | 12869 | 7 | `s_m_Load_AE2E_BTP_PREP_FGDD` |
| 6 | BTP_PREP_FGDI | 37 | 12870 | 7 | `s_m_Load_AE2E_BTP_PREP_FGDI` |

#### DG_89 — 6 members
- **Sources:** `PRODUCT_SPECIFICATION`
- **Targets:** `CODS, PRODUCT_SPECIFICATION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BM_PRODUCT_SPECIFICATION | 1 | 1220 | 10 | `s_m_Load_BM_PRODUCT_SPECIFICATION` |
| 2 | CRIS_PRODUCT_SPECIFICATION | 1 | 1873 | 10 | `s_m_Load_CRIS_PRODUCT_SPECIFICATION` |
| 3 | ENS_PRODUCT_SPECIFICATION | 1 | 2503 | 10 | `s_m_Load_ENS_PRODUCT_SPECIFICATION` |
| 4 | SERVICENOW_PRODUCT_SPECIFICATION | 1 | 3412 | 10 | `s_m_Load_LUMEN_SERVICENOW_PRODUCT_SPECIFICATION` |
| 5 | QF_PRODUCT_SPECIFICATION | 1 | 4460 | 10 | `s_m_Load_QF_PRODUCT_SPECIFICATION` |
| 6 | RSOR_PRODUCT_SPECIFICATION | 1 | 4778 | 10 | `s_m_Load_RSOR_PRODUCT_SPECIFICATION` |

#### DG_90 — 6 members
- **Sources:** `PARTITION_EXCH_CONTROL, PARTITION_EXCH_CONTROL1`
- **Targets:** `TGT_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Check_Partiton_Exchange | 2 | 7795 | 2 | `s_m_Check_Partiton_Exchange` |
| 2 | Partiton_Exchange_KenanIDC | 2 | 7796 | 2 | `s_m_Check_Partiton_Exchange_KenanIDC` |
| 3 | Partiton_Exchange_PostCorr | 2 | 7797 | 2 | `s_m_Check_Partiton_Exchange_PostCorr` |
| 4 | Partiton_Exchange_UP | 2 | 7798 | 2 | `s_m_Check_Partiton_Exchange_UP` |
| 5 | Partiton_Exchange_VERO | 2 | 7799 | 2 | `s_m_Check_Partiton_Exchange_VERO` |
| 6 | Exchange_Complete_Ind | 2 | 8496 | 2 | `s_m_Update_Exchange_Complete_Ind` |

#### DG_91 — 6 members
- **Sources:** `BILL_INVOICE, INVOICE, INVOICE1`
- **Targets:** `CDW_COMMON, REJECTED_ROW`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FOR_INVOICE_IDC | 15 | 10230 | 5 | `s_m_Load_REJECTED_ROW_FOR_INVOICE_IDC` |
| 2 | INVOICE_ITEM_IDC | 15 | 10231 | 8 | `s_m_Load_REJECTED_ROW_FOR_INVOICE_ITEM_IDC` |
| 3 | INVOICE_ITEM_KENANFX | 15 | 10232 | 8 | `s_m_Load_REJECTED_ROW_FOR_INVOICE_ITEM_KENANFX` |
| 4 | ITEM_TAX_IDC | 15 | 10234 | 8 | `s_m_Load_REJECTED_ROW_FOR_INVOICE_ITEM_TAX_IDC` |
| 5 | ITEM_TAX_KENANFX | 15 | 10235 | 8 | `s_m_Load_REJECTED_ROW_FOR_INVOICE_ITEM_TAX_KENANFX` |
| 6 | FOR_INVOICE_KENANFX | 15 | 10237 | 5 | `s_m_Load_REJECTED_ROW_FOR_INVOICE_KENANFX` |

#### DG_92 — 6 members
- **Sources:** `TASK_INST_PARAMS, TASK_INST_PARAMS2`
- **Targets:** `TASK_INST_PARAMS, WM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INST_PARAMS_Hist | 1 | 5946 | 9 | `s_m_Load_TASK_INST_PARAMS_Hist` |
| 2 | INST_PARAMS_Hist1 | 1 | 5947 | 9 | `s_m_Load_TASK_INST_PARAMS_Hist1` |
| 3 | INST_PARAMS_Hist2 | 1 | 5948 | 9 | `s_m_Load_TASK_INST_PARAMS_Hist2` |
| 4 | INST_PARAMS_Hist3 | 1 | 5949 | 9 | `s_m_Load_TASK_INST_PARAMS_Hist3` |
| 5 | INST_PARAMS_Hist4 | 1 | 5950 | 9 | `s_m_Load_TASK_INST_PARAMS_Hist4` |
| 6 | INST_PARAMS_Hist5 | 1 | 5951 | 9 | `s_m_Load_TASK_INST_PARAMS_Hist5` |

#### DG_93 — 6 members
- **Sources:** `MISSING_ROW`
- **Targets:** `CDW_COMMON, REJECTED_ROW`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INVOICE_CDC_KENAN | 16 | 10360 | 1 | `s_m_Load_MISSING_INVOICES_FOR_INVOICE_CDC_KENAN` |
| 2 | INVOICE_IDC_KENAN | 16 | 10361 | 1 | `s_m_Load_MISSING_INVOICES_FOR_INVOICE_IDC_KENAN` |
| 3 | ITEM_CDC_KENAN | 16 | 10362 | 1 | `s_m_Load_MISSING_INVOICES_FOR_INVOICE_ITEM_CDC_KENAN` |
| 4 | ITEM_IDC_KENAN | 16 | 10363 | 1 | `s_m_Load_MISSING_INVOICES_FOR_INVOICE_ITEM_IDC_KENAN` |
| 5 | TAX_CDC_KENAN | 16 | 10364 | 1 | `s_m_Load_MISSING_INVOICES_FOR_INVOICE_ITEM_TAX_CDC_KENAN` |
| 6 | TAX_IDC_KENAN | 16 | 10365 | 1 | `s_m_Load_MISSING_INVOICES_FOR_INVOICE_ITEM_TAX_IDC_KENAN` |

#### DG_94 — 6 members
- **Sources:** `SRC_TID, SRC_TOPOLOGY`
- **Targets:** `ASLNTFLX, STG_MLSN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_MLSN1 | 1 | 3482 | 16 | `s_m_Load_MLSN1` |
| 2 | Load_MLSN11 | 1 | 3483 | 16 | `s_m_Load_MLSN11` |
| 3 | Load_MLSN4 | 1 | 3484 | 16 | `s_m_Load_MLSN4` |
| 4 | Load_MLSN5 | 1 | 3485 | 16 | `s_m_Load_MLSN5` |
| 5 | Load_MLSN6 | 1 | 3486 | 16 | `s_m_Load_MLSN6` |
| 6 | Load_MLSN7 | 1 | 3487 | 16 | `s_m_Load_MLSN7` |

#### DG_95 — 6 members
- **Sources:** `SRC_TID, SRC_TOPOLOGY`
- **Targets:** `ASLNTFLX, STG_TOPOLOGY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_TOPOLOGY1 | 1 | 6164 | 6 | `s_m_Load_TOPOLOGY1` |
| 2 | Load_TOPOLOGY11 | 1 | 6165 | 6 | `s_m_Load_TOPOLOGY11` |
| 3 | Load_TOPOLOGY4 | 1 | 6166 | 6 | `s_m_Load_TOPOLOGY4` |
| 4 | Load_TOPOLOGY5 | 1 | 6167 | 6 | `s_m_Load_TOPOLOGY5` |
| 5 | Load_TOPOLOGY6 | 1 | 6168 | 6 | `s_m_Load_TOPOLOGY6` |
| 6 | Load_TOPOLOGY7 | 1 | 6169 | 6 | `s_m_Load_TOPOLOGY7` |

#### DG_96 — 6 members
- **Sources:** `AE2E_AM_OFFNET_MGR_PREP, AE2E_AM_OFFNET_MGR_PREP1, AE2E_AM_OFFNET_MGR_PREP2, AE2E_AM_OFFNET_MGR_PREP3, AE2E_JOB_LOG +3 more`
- **Targets:** `AE2E_JOB_LOG, AE2E_ODW_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ODW_PREP_WCD | 37 | 12859 | 14 | `s_m_LOAD_AE2E_ODW_PREP_WCD` |
| 2 | ODW_PREP_WCI | 37 | 12860 | 14 | `s_m_LOAD_AE2E_ODW_PREP_WCI` |
| 3 | ODW_PREP_WND | 37 | 12861 | 14 | `s_m_LOAD_AE2E_ODW_PREP_WND` |
| 4 | ODW_PREP_WNI | 37 | 12862 | 14 | `s_m_LOAD_AE2E_ODW_PREP_WNI` |
| 5 | ODW_PREP_FGDD | 37 | 12871 | 14 | `s_m_Load_AE2E_ODW_PREP_FGDD` |
| 6 | ODW_PREP_FGDI | 37 | 12872 | 14 | `s_m_Load_AE2E_ODW_PREP_FGDI` |

#### DG_97 — 6 members
- **Sources:** `CIRCUIT_ORDER_STG, ORDER_PRODUCT_ENDPNT, ORDER_PRODUCT_ENDPNT1, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, ORDER_PRODUCT_ENDPNT`
- **Lookups:** `CUSTOMER_ORDER_PRODUCT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_ENDPNT | 18 | 10550 | 11 | `s_m_Load_EASE_CABS_ORDER_PRODUCT_ENDPNT` |
| 2 | ORDER_PRODUCT_ENDPNT | 18 | 10563 | 11 | `s_m_Load_ENS_ORDER_PRODUCT_ENDPNT` |
| 3 | ORDER_PRODUCT_ENDPNT | 22 | 11017 | 12 | `s_m_Load_NETWORX_ORDER_PRODUCT_ENDPNT` |
| 4 | ORDER_PRODUCT_ENDPNT | 27 | 11616 | 12 | `s_m_Load_SIEBEL8_LATAM_ORDER_PRODUCT_ENDPNT` |
| 5 | ORDER_PRODUCT_ENDPNT | 29 | 11957 | 11 | `s_m_Load_VANTIVE_ORDER_PRODUCT_ENDPNT` |
| 6 | ORDER_PRODUCT_ENDPNT | 29 | 11964 | 11 | `s_m_Load_VLOCITY_ORDER_PRODUCT_ENDPNT` |

#### DG_98 — 6 members
- **Sources:** `LOCATION, STRUCTURE, STRUCTURE_UNIT`
- **Targets:** `CODS_NETINV, PHYS_STRUCT`
- **Lookups:** `CUSTOMER, INV_STATUS_TYPE, PHYS_STRUCT, STATE_CD, STRUCTURE_UNIT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PHYS_STRUCT_AIL | 9 | 9688 | 14 | `s_m_Load_PHYS_STRUCT_AIL` |
| 2 | PHYS_STRUCT_BAY | 9 | 9689 | 14 | `s_m_Load_PHYS_STRUCT_BAY` |
| 3 | PHYS_STRUCT_BUILDING | 9 | 9690 | 14 | `s_m_Load_PHYS_STRUCT_BUILDING` |
| 4 | PHYS_STRUCT_FLR | 9 | 9691 | 14 | `s_m_Load_PHYS_STRUCT_FLR` |
| 5 | PHYS_STRUCT_ROM | 9 | 9692 | 14 | `s_m_Load_PHYS_STRUCT_ROM` |
| 6 | PHYS_STRUCT_SUT | 9 | 9693 | 14 | `s_m_Load_PHYS_STRUCT_SUT` |

#### DG_99 — 6 members
- **Sources:** `EQUIPMENT_HOLDER, RACK_POSITION, RACK_POSITION1`
- **Targets:** `CODS_NETINV, RACK_POSITION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | POSITION_AMDOCS_RM | 9 | 9701 | 11 | `s_m_Load_RACK_POSITION_AMDOCS_RM` |
| 2 | RACK_POSITION_ARM | 9 | 9702 | 10 | `s_m_Load_RACK_POSITION_ARM` |
| 3 | RACK_POSITION_EON | 9 | 9703 | 10 | `s_m_Load_RACK_POSITION_EON` |
| 4 | RACK_POSITION_LIMS | 9 | 9705 | 10 | `s_m_Load_RACK_POSITION_LIMS` |
| 5 | RACK_POSITION_RSI | 9 | 9706 | 11 | `s_m_Load_RACK_POSITION_RSI` |
| 6 | RACK_POSITION_TIRKS | 9 | 9707 | 10 | `s_m_Load_RACK_POSITION_TIRKS` |

#### DG_100 — 6 members
- **Sources:** `DUMMY`
- **Targets:** `FF_XML_TARGET, JOB_STATUS_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Paramfile_TimedOut_Green | 3 | 8713 | 3 | `s_m_Adjust_Paramfile_TimedOut_Green` |
| 2 | Paramfile_TimedOut_Red | 3 | 8716 | 3 | `s_m_Adjust_Paramfile_TimedOut_Red` |
| 3 | InBetweenDates_Recovery_Green | 3 | 8749 | 10 | `s_m_Get_InBetweenDates_Recovery_Green` |
| 4 | InBetweenDates_Recovery_Red | 3 | 8750 | 10 | `s_m_Get_InBetweenDates_Recovery_Red` |
| 5 | Get_InBtwnDates_Green | 3 | 8751 | 10 | `s_m_Get_InBtwnDates_Green` |
| 6 | Get_InBtwnDates_Red | 3 | 8752 | 10 | `s_m_Get_InBtwnDates_Red` |

#### DG_101 — 6 members
- **Sources:** `F_BILLING_ROLLUP, F_BILLING_ROLLUP1`
- **Targets:** `DUMMY_TGT, F_BILLED_REVENUE_QRTR`
- **Lookups:** `CCAT_EIS_CHARGE_ELIGIBLITY, F_FEDERAL_TAX_EXEMPTIONS, STATE_VALUES, U_CHARGE_ID_MAP, U_TAX_TYPE_CODE_MAP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_QRTR_100 | 16 | 10300 | 28 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_100` |
| 2 | REVENUE_QRTR_131 | 16 | 10302 | 28 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_131` |
| 3 | REVENUE_QRTR_169 | 16 | 10305 | 28 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_169` |
| 4 | REVENUE_QRTR_175 | 16 | 10306 | 28 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_175` |
| 5 | REVENUE_QRTR_641 | 16 | 10311 | 27 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_641` |
| 6 | REVENUE_QRTR_S278 | 16 | 10313 | 28 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_S278` |

#### DG_102 — 6 members
- **Sources:** `D_CUSTOMER, D_CUSTOMER1, D_TRUNKGROUP, D_TRUNKGROUP1, D_TRUNKGROUP11 +3 more`
- **Targets:** `FF_TG_TRAFFIC_REPORT`
- **Lookups:** `CRETG, D_TRUNKGROUP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Report_NASS_ISS | 22 | 10951 | 12 | `s_m_Create_1Day_TG_Traffic_Report_NASS_ISS` |
| 2 | Traffic_Report_BLUE | 22 | 10952 | 12 | `s_m_Create_1Hour_TG_Traffic_Report_BLUE` |
| 3 | Report_NASS_ISS | 22 | 10953 | 12 | `s_m_Create_1Hour_TG_Traffic_Report_NASS_ISS` |
| 4 | Traffic_Report_BLUE | 22 | 10958 | 12 | `s_m_Create_5Min_TG_Traffic_Report_BLUE` |
| 5 | NASS_ISS_GSX | 22 | 10959 | 12 | `s_m_Create_5Min_TG_Traffic_Report_NASS_ISS_GSX` |
| 6 | NASS_ISS_NBS | 22 | 10960 | 12 | `s_m_Create_5Min_TG_Traffic_Report_NASS_ISS_NBS` |

#### DG_103 — 6 members
- **Sources:** `DUAL`
- **Targets:** `FF_PARAMETERS_LOAD_END_TIME`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SESS_START_TIME | 30 | 12029 | 2 | `s_m_CAPTURE_SESS_START_TIME` |
| 2 | START_TIME_1 | 30 | 12030 | 2 | `s_m_CAPTURE_SESS_START_TIME_1` |
| 3 | Load_End_Time | 30 | 12198 | 1 | `s_m_NOE_Update_Parameters_Load_End_Time` |
| 4 | Load_End_Time | 30 | 12233 | 1 | `s_m_WORKFLOW_Update_Parameters_Load_End_Time` |
| 5 | End_Time_EWFM | 30 | 12234 | 1 | `s_m_WORKFLOW_Update_Parameters_Load_End_Time_EWFM` |
| 6 | End_Time_RSI | 30 | 12235 | 1 | `s_m_WORKFLOW_Update_Parameters_Load_End_Time_RSI` |

#### DG_104 — 6 members
- **Sources:** `DUMMY_SRC`
- **Targets:** `FF_DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SITETRACKER_SITE_365 | 1 | 795 | 2 | `s_m_LOAD_SITETRACKER_SITE_365` |
| 2 | Load_TICKET_365 | 1 | 6067 | 2 | `s_m_Load_TICKET_365` |
| 3 | TICKET_RESPONSE_365 | 1 | 6069 | 2 | `s_m_Load_TICKET_RESPONSE_365` |
| 4 | REPORT_FOR_LEGACY | 1 | 7527 | 2 | `s_m_load_SOX_REPORT_FOR_LEGACY` |
| 5 | LEVEL3_FALIURE_LIST | 1 | 7528 | 2 | `s_m_load_SOX_TABLE_FOR_LEVEL3_FALIURE_LIST` |
| 6 | FOR_MASS_MARKET | 1 | 7529 | 2 | `s_m_load_SOX_TABLE_FOR_MASS_MARKET` |

#### DG_105 — 6 members
- **Sources:** `LOCATION, PHYSICAL_SITE, PHYS_STRUCT, PHYS_STRUCT1, STD_NET_SITE_CODE_DEF`
- **Targets:** `CODS_NETINV, PHYS_STRUCT`
- **Lookups:** `COUNTRY, CUSTOMER, GL_BUSINESS_AREA, GL_SEG2_PROFIT_CTR, L3AR_GL_PROFIT_CENTER +8 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STRUCT_LMS_AISLE | 16 | 10384 | 8 | `s_m_Load_PHYS_STRUCT_LMS_AISLE` |
| 2 | STRUCT_LMS_BAY | 16 | 10385 | 8 | `s_m_Load_PHYS_STRUCT_LMS_BAY` |
| 3 | STRUCT_LMS_BUILDING | 16 | 10386 | 8 | `s_m_Load_PHYS_STRUCT_LMS_BUILDING` |
| 4 | STRUCT_LMS_FLOOR | 16 | 10387 | 8 | `s_m_Load_PHYS_STRUCT_LMS_FLOOR` |
| 5 | STRUCT_LMS_ROOM | 16 | 10388 | 8 | `s_m_Load_PHYS_STRUCT_LMS_ROOM` |
| 6 | STRUCT_LMS_SUITE | 16 | 10389 | 8 | `s_m_Load_PHYS_STRUCT_LMS_SUITE` |

#### DG_106 — 6 members
- **Sources:** `DOMAIN`
- **Targets:** `CI_DOMAIN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | all_business_metrics | 1 | 7060 | 3 | `s_m_all_business_metrics` |
| 2 | analyze_tables | 1 | 7062 | 3 | `s_m_analyze_tables` |
| 3 | ci_domain | 1 | 7086 | 1 | `s_m_ci_domain` |
| 4 | storm_vendor_tab | 1 | 7612 | 3 | `s_m_storm_vendor_tab` |
| 5 | truncate_stage | 1 | 7619 | 3 | `s_m_truncate_stage` |
| 6 | truncate_stage1 | 1 | 7620 | 3 | `s_m_truncate_stage1` |

#### DG_107 — 5 members
- **Sources:** `DUMMY_SRCE, PROCESS_PARAMETER`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ALL_CURR_MNTH | 16 | 10410 | 13 | `s_m_Load_SWP_DH_BILLING_ACCOUNT_ALL_CURR_MNTH` |
| 2 | ALL_NEXT_MNTH | 16 | 10411 | 13 | `s_m_Load_SWP_DH_BILLING_ACCOUNT_ALL_NEXT_MNTH` |
| 3 | HIERARCHY_CURR_MNTH | 16 | 10416 | 13 | `s_m_Load_SWP_DH_CUSTOMER_HIERARCHY_CURR_MNTH` |
| 4 | HIERARCHY_NEXT_MNTH | 16 | 10417 | 13 | `s_m_Load_SWP_DH_CUSTOMER_HIERARCHY_NEXT_MNTH` |
| 5 | Set_Initial_Mode | 16 | 10439 | 4 | `s_m_Load_Set_Initial_Mode` |

#### DG_108 — 5 members
- **Sources:** `STG_CIRCUIT_ASG_TSC_ALLOC, STG_CIRCUIT_ASG_TSC_ALLOC1, VENDOR, VENDOR1`
- **Targets:** `CODS_NETEX_STG, STG_CIRCUIT_ASG_TSC_ALLOC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASG_TSC_CHARGES | 11 | 9886 | 14 | `s_m_Load_NETEX_UNALLOC_ASG_TSC_CHARGES` |
| 2 | TSC_CHARGES_CTL | 11 | 9887 | 14 | `s_m_Load_NETEX_UNALLOC_ASG_TSC_CHARGES_CTL` |
| 3 | TSC_CHARGES_SAM | 11 | 9888 | 30 | `s_m_Load_NETEX_UNALLOC_ASG_TSC_CHARGES_SAM` |
| 4 | CHARGES_SAM_EMEA | 11 | 9889 | 30 | `s_m_Load_NETEX_UNALLOC_ASG_TSC_CHARGES_SAM_EMEA` |
| 5 | CHARGES_SAM_LATAM | 11 | 9890 | 30 | `s_m_Load_NETEX_UNALLOC_ASG_TSC_CHARGES_SAM_LATAM` |

#### DG_109 — 5 members
- **Sources:** `ASSET_PRODUCT_ENDPNT, CIRCUIT_ASSET_STG`
- **Targets:** `ASSET_PRODUCT_ENDPNT, CODS`
- **Lookups:** `ASSET_PRODUCT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASSET_PRODUCT_ENDPNT | 14 | 10130 | 10 | `s_m_Load_CRIS_ASSET_PRODUCT_ENDPNT` |
| 2 | ASSET_PRODUCT_ENDPNT | 14 | 10141 | 10 | `s_m_Load_ENS_ASSET_PRODUCT_ENDPNT` |
| 3 | ASSET_PRODUCT_ENDPNT | 22 | 10994 | 10 | `s_m_Load_LUMEN_SERVICENOW_ASSET_PRODUCT_ENDPNT` |
| 4 | ASSET_PRODUCT_ENDPNT | 27 | 11583 | 10 | `s_m_Load_PROD_ASSET_PRODUCT_ENDPNT` |
| 5 | ASSET_PRODUCT_ENDPNT | 29 | 11956 | 10 | `s_m_Load_VANTIVE_ASSET_PRODUCT_ENDPNT` |

#### DG_110 — 5 members
- **Sources:** `USOC_BILLED`
- **Targets:** `USOC_BILLED`
- **Lookups:** `SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CAD_SAM_EMEA | 21 | 10850 | 10 | `s_m_Load_NETEX_USOC_BILLED_CAD_SAM_EMEA` |
| 2 | BILLED_OUTDATED_INVOICES | 24 | 11296 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OUTDATED_INVOICES` |
| 3 | OUTDATED_INVOICES_CTL | 24 | 11297 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OUTDATED_INVOICES_CTL` |
| 4 | OUTDATED_INVOICES_SAM | 24 | 11298 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OUTDATED_INVOICES_SAM` |
| 5 | INVOICES_SAM_EMEA | 24 | 11299 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OUTDATED_INVOICES_SAM_EMEA` |

#### DG_111 — 5 members
- **Sources:** `CARD, EQUIPMENT`
- **Targets:** `CARD, CODS_NETINV`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CARD_AMDOCS_RM | 1 | 1349 | 10 | `s_m_Load_CARD_AMDOCS_RM` |
| 2 | Load_CARD_ARM | 1 | 1350 | 10 | `s_m_Load_CARD_ARM` |
| 3 | Load_CARD_LIMS | 1 | 1353 | 10 | `s_m_Load_CARD_LIMS` |
| 4 | Load_CARD_RSI | 1 | 1356 | 10 | `s_m_Load_CARD_RSI` |
| 5 | Load_CARD_TIRKS | 1 | 1359 | 10 | `s_m_Load_CARD_TIRKS` |

#### DG_112 — 5 members
- **Sources:** `PROCESS_CONTROL_MASTER`
- **Targets:** `PROCESS_CONTROL_MASTER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CDD_Upd_PCM | 1 | 109 | 3 | `s_m_CDD_Upd_PCM` |
| 2 | Upd_PCM_Pre | 1 | 110 | 3 | `s_m_CDD_Upd_PCM_Pre` |
| 3 | CD_Upd_PCM | 1 | 120 | 3 | `s_m_CD_Upd_PCM` |
| 4 | Upd_PCM_Pre | 1 | 121 | 3 | `s_m_CD_Upd_PCM_Pre` |
| 5 | PROCESS_CONTROL_MASTER | 1 | 7022 | 2 | `s_m_Update_PROCESS_CONTROL_MASTER` |

#### DG_113 — 5 members
- **Sources:** `CHASSIS, EQUIPMENT`
- **Targets:** `CHASSIS, CODS_NETINV`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CHASSIS_AMDOCS_RM | 1 | 1522 | 10 | `s_m_Load_CHASSIS_AMDOCS_RM` |
| 2 | Load_CHASSIS_ARM | 1 | 1523 | 10 | `s_m_Load_CHASSIS_ARM` |
| 3 | Load_CHASSIS_LIMS | 1 | 1524 | 10 | `s_m_Load_CHASSIS_LIMS` |
| 4 | Load_CHASSIS_RSI | 1 | 1526 | 10 | `s_m_Load_CHASSIS_RSI` |
| 5 | Load_CHASSIS_TIRKS | 1 | 1527 | 10 | `s_m_Load_CHASSIS_TIRKS` |

#### DG_114 — 5 members
- **Sources:** `ASL_SYNCHRONOSS, SUPPLIER, SUPPLIER1`
- **Targets:** `ASL_SYNCHRONOSS_BKP, EXP_VALIDATION_CHECK`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COUNT_VALIDATION_SAM | 10 | 9759 | 15 | `s_m_Load_ASL_SAM_SYNC_COUNT_VALIDATION_SAM` |
| 2 | VALIDATION_SAM_LATAM | 10 | 9760 | 15 | `s_m_Load_ASL_SAM_SYNC_COUNT_VALIDATION_SAM_LATAM` |
| 3 | VALIDATION_SAM_LATAM | 10 | 9790 | 15 | `s_m_Load_NETEX_SOURCE_COUNT_VALIDATION_SAM_LATAM` |
| 4 | VALIDATION_SOURCE_COUNT | 10 | 9802 | 15 | `s_m_Load_NETEX_VALIDATION_SOURCE_COUNT` |
| 5 | SOURCE_COUNT_EMEA | 10 | 9803 | 15 | `s_m_Load_NETEX_VALIDATION_SOURCE_COUNT_EMEA` |

#### DG_115 — 5 members
- **Sources:** `BILL_INVOICE, DUMMY`
- **Targets:** `FF_PARAMETER_FILE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DT_CABS_param | 11 | 9861 | 2 | `s_m_Load_GL_PERIOD_START_DT_CABS_param` |
| 2 | DT_DASSIAN_param | 11 | 9862 | 2 | `s_m_Load_GL_PERIOD_START_DT_DASSIAN_param` |
| 3 | DT_ENS_param | 11 | 9863 | 2 | `s_m_Load_GL_PERIOD_START_DT_ENS_param` |
| 4 | DT_KENAN_param | 11 | 9864 | 2 | `s_m_Load_GL_PERIOD_START_DT_KENAN_param` |
| 5 | DT_NIBS_parm | 11 | 9865 | 2 | `s_m_Load_GL_PERIOD_START_DT_NIBS_parm` |

#### DG_116 — 5 members
- **Sources:** `FF_DUMMY`
- **Targets:** `FF_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Data_Loading_Status | 1 | 546 | 4 | `s_m_Check_DTE_Data_Loading_Status` |
| 2 | Copy_SFTP_Files | 1 | 581 | 5 | `s_m_Copy_SFTP_Files` |
| 3 | Get_FTP_Files | 1 | 652 | 2 | `s_m_Get_FTP_Files` |
| 4 | Get_SFTP_Files | 1 | 653 | 2 | `s_m_Get_SFTP_Files` |
| 5 | AS_CLUSTER_Files | 1 | 6816 | 5 | `s_m_Select_AS_CLUSTER_Files` |

#### DG_117 — 5 members
- **Sources:** `PARTY_PHYS_STRUCT_ROLE, PHYS_STRUCT`
- **Targets:** `DSL_AML, FRAB`
- **Lookups:** `FRAB, SITE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_FRAB_AISLE | 6 | 9376 | 8 | `s_m_Load_FRAB_AISLE` |
| 2 | Load_FRAB_BAY | 6 | 9377 | 8 | `s_m_Load_FRAB_BAY` |
| 3 | Load_FRAB_FLOOR | 6 | 9378 | 8 | `s_m_Load_FRAB_FLOOR` |
| 4 | Load_FRAB_ROOM | 6 | 9379 | 8 | `s_m_Load_FRAB_ROOM` |
| 5 | Load_FRAB_SUITE | 6 | 9380 | 8 | `s_m_Load_FRAB_SUITE` |

#### DG_118 — 5 members
- **Sources:** `ARC_CKT_DETAIL_ZOOM, ARC_CKT_ORDER, CKT_TRACKING, TBLCIRCUITS_TST`
- **Targets:** `TBLCIRCUITS_TST`
- **Lookups:** `ALIAS_VENDOR, CUSTOMER_DICT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_Tblcircuits_tst5 | 2 | 8407 | 10 | `s_m_Load_Tblcircuits_tst5` |
| 2 | Load_Tblcircuits_tst6 | 2 | 8408 | 10 | `s_m_Load_Tblcircuits_tst6` |
| 3 | Load_Tblcircuits_tst7 | 2 | 8409 | 10 | `s_m_Load_Tblcircuits_tst7` |
| 4 | Load_Tblcircuits_tst8 | 2 | 8410 | 10 | `s_m_Load_Tblcircuits_tst8` |
| 5 | Load_Tblcircuits_tst9 | 2 | 8411 | 10 | `s_m_Load_Tblcircuits_tst9` |

#### DG_119 — 5 members
- **Sources:** `DUMMY_TMP`
- **Targets:** `FF_DUMMY2`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ODS_ID_UPD | 1 | 2918 | 3 | `s_m_Load_FRD_CABS_BPC_ODS_ID_UPD` |
| 2 | FRD_INS_UPD | 1 | 2919 | 3 | `s_m_Load_FRD_INS_UPD` |
| 3 | INS_UPD_CABS | 1 | 2920 | 3 | `s_m_Load_FRD_INS_UPD_CABS` |
| 4 | INS_UPD_NIBS | 1 | 2921 | 3 | `s_m_Load_FRD_INS_UPD_NIBS` |
| 5 | RSL_AND_JRNL | 1 | 2967 | 3 | `s_m_Load_F_REVENUE_DETAIL_RSL_AND_JRNL` |

#### DG_120 — 5 members
- **Sources:** `PRODUCT_COMPNT_ENDPNT, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_COMPNT_ENDPNT`
- **Lookups:** `ORDER_PRODUCT_COMPNT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_COMPNT_ENDPNT | 14 | 10119 | 12 | `s_m_Load_CLARIFY_PRODUCT_COMPNT_ENDPNT` |
| 2 | PRODUCT_COMPNT_ENDPNT | 19 | 10615 | 11 | `s_m_Load_EASE_CABS_PRODUCT_COMPNT_ENDPNT` |
| 3 | PRODUCT_COMPNT_ENDPNT | 23 | 11150 | 12 | `s_m_Load_ORACLE2E_PRODUCT_COMPNT_ENDPNT` |
| 4 | PRODUCT_COMPNT_ENDPNT | 29 | 11958 | 11 | `s_m_Load_VANTIVE_PRODUCT_COMPNT_ENDPNT` |
| 5 | PRODUCT_COMPNT_ENDPNT | 29 | 11965 | 11 | `s_m_Load_VLOCITY_PRODUCT_COMPNT_ENDPNT` |

#### DG_121 — 5 members
- **Sources:** `D_TAXMART_PERIOD, D_TAXMART_PERIOD1`
- **Targets:** `FL_GENERATED_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REPORT_FOR_KENAN | 12 | 9922 | 5 | `s_m_GENERATE_PARAMETERS_LOAD_TR_REPORT_FOR_KENAN` |
| 2 | FOR_MANUAL_CREDIT | 12 | 9923 | 5 | `s_m_GENERATE_PARAMETERS_LOAD_TR_REPORT_FOR_MANUAL_CREDIT` |
| 3 | FOR_ORACLE_AR | 12 | 9924 | 5 | `s_m_GENERATE_PARAMETERS_LOAD_TR_REPORT_FOR_ORACLE_AR` |
| 4 | REPORT_FOR_TELCOVE | 12 | 9925 | 5 | `s_m_GENERATE_PARAMETERS_LOAD_TR_REPORT_FOR_TELCOVE` |
| 5 | REPORT_FOR_USETAX | 12 | 9926 | 5 | `s_m_GENERATE_PARAMETERS_LOAD_TR_REPORT_FOR_USETAX` |

#### DG_122 — 5 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_MNTH, BILLED_REVENUE_RGLTRY_VW_MNTH1, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2 +3 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_MNTH`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_MNTH_206 | 25 | 11323 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_206` |
| 2 | REVENUE_MNTH_242 | 25 | 11324 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_242` |
| 3 | REVENUE_MNTH_273 | 25 | 11325 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_273` |
| 4 | REVENUE_MNTH_641 | 25 | 11327 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_641` |
| 5 | REVENUE_MNTH_CBP | 25 | 11328 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_CBP` |

#### DG_123 — 5 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_QRTR, BILLED_REVENUE_TAX_VW_QRTR`
- **Targets:** `F_RVN_CTGRY_ALLCTN_PRCNT_QRTR, TAXMART`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_QRTR_166 | 1 | 79 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_166` |
| 2 | REVENUE_QRTR_169 | 1 | 80 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_169` |
| 3 | REVENUE_QRTR_175 | 1 | 81 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_175` |
| 4 | REVENUE_QRTR_273 | 1 | 84 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_273` |
| 5 | REVENUE_QRTR_641 | 1 | 86 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_QRTR_641` |

#### DG_124 — 5 members
- **Sources:** `F_BILLING_ROLLUP, F_BILLING_ROLLUP1`
- **Targets:** `DUMMY_TGT, F_BILLED_REVENUE_YR`
- **Lookups:** `CCAT_EIS_CHARGE_ELIGIBLITY, F_FEDERAL_TAX_EXEMPTIONS, STATE_VALUES, U_CHARGE_ID_MAP, U_TAX_TYPE_CODE_MAP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_100 | 16 | 10314 | 28 | `s_m_LOAD_F_BILLED_REVENUE_YR_100` |
| 2 | REVENUE_YR_131 | 16 | 10316 | 28 | `s_m_LOAD_F_BILLED_REVENUE_YR_131` |
| 3 | REVENUE_YR_169 | 16 | 10319 | 28 | `s_m_LOAD_F_BILLED_REVENUE_YR_169` |
| 4 | REVENUE_YR_175 | 16 | 10320 | 28 | `s_m_LOAD_F_BILLED_REVENUE_YR_175` |
| 5 | REVENUE_YR_S278 | 16 | 10327 | 28 | `s_m_LOAD_F_BILLED_REVENUE_YR_S278` |

#### DG_125 — 5 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_YR, BILLED_REVENUE_TAX_VW_YR, BILLED_REVENUE_TAX_VW_YR2`
- **Targets:** `F_RVN_CTGRY_ALLCTN_PRCNT_YR, TAXMART`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_166 | 1 | 94 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_166` |
| 2 | REVENUE_YR_169 | 1 | 95 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_169` |
| 3 | REVENUE_YR_175 | 1 | 96 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_175` |
| 4 | REVENUE_YR_273 | 1 | 99 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_273` |
| 5 | REVENUE_YR_641 | 1 | 101 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_YR_641` |

#### DG_126 — 5 members
- **Sources:** `LOCATION, PHYS_STRUCT`
- **Targets:** `CODS_NETINV, PHYS_STRUCT`
- **Lookups:** `PHYS_STRUCT, PHYS_STRUCT_CLLI_LIST`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STRUCT_AMDOCS_AISLE | 4 | 9121 | 10 | `s_m_Load_PHYS_STRUCT_AMDOCS_AISLE` |
| 2 | STRUCT_AMDOCS_AREA | 4 | 9122 | 10 | `s_m_Load_PHYS_STRUCT_AMDOCS_AREA` |
| 3 | STRUCT_AMDOCS_ENTITY | 4 | 9123 | 10 | `s_m_Load_PHYS_STRUCT_AMDOCS_ENTITY` |
| 4 | STRUCT_AMDOCS_FLOOR | 4 | 9124 | 10 | `s_m_Load_PHYS_STRUCT_AMDOCS_FLOOR` |
| 5 | STRUCT_AMDOCS_ROOM | 4 | 9125 | 10 | `s_m_Load_PHYS_STRUCT_AMDOCS_ROOM` |

#### DG_127 — 5 members
- **Sources:** `SUPPLIER_CIRCUIT_INTERNAL, SUPPLIER_CIRCUIT_INTERNAL1`
- **Targets:** `CODS_NETEX, SUPPLIER_CIRCUIT_INTERNAL`
- **Lookups:** `SUPPLIER_CIRCUIT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SUPPLIER_CIRCUIT_INTERNAL | 19 | 10639 | 12 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_INTERNAL` |
| 2 | CIRCUIT_INTERNAL_CTL | 19 | 10640 | 12 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_INTERNAL_CTL` |
| 3 | CIRCUIT_INTERNAL_SAM | 19 | 10641 | 12 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_INTERNAL_SAM` |
| 4 | INTERNAL_SAM_EMEA | 19 | 10642 | 12 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_INTERNAL_SAM_EMEA` |
| 5 | INTERNAL_SAM_LATAM | 19 | 10643 | 12 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_INTERNAL_SAM_LATAM` |

#### DG_128 — 5 members
- **Sources:** `F_BILLING_ROLLUP`
- **Targets:** `F_TAXES_BILLED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TAXES_BILLED_MBS | 16 | 10332 | 2 | `s_m_LOAD_F_TAXES_BILLED_MBS` |
| 2 | TAXES_BILLED_CABS | 16 | 10346 | 2 | `s_m_Load_F_TAXES_BILLED_CABS` |
| 3 | TAXES_BILLED_ENS | 16 | 10347 | 2 | `s_m_Load_F_TAXES_BILLED_ENS` |
| 4 | TAXES_BILLED_LATIS | 16 | 10348 | 2 | `s_m_Load_F_TAXES_BILLED_LATIS` |
| 5 | TAXES_BILLED_ZUORA | 16 | 10349 | 2 | `s_m_Load_F_TAXES_BILLED_ZUORA` |

#### DG_129 — 5 members
- **Sources:** `TN_INVENTORY, TN_INVENTORY1`
- **Targets:** `CODS_TN, TN_INVENTORY`
- **Lookups:** `SOURCE_BILLING_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TN_INVENTORY_HISTORICAL | 25 | 11450 | 3 | `s_m_Update_TN_INVENTORY_HISTORICAL` |
| 2 | HISTORICAL_LEXM_GNAS | 25 | 11451 | 3 | `s_m_Update_TN_INVENTORY_HISTORICAL_LEXM_GNAS` |
| 3 | HISTORICAL_LEXM_INTF | 25 | 11452 | 3 | `s_m_Update_TN_INVENTORY_HISTORICAL_LEXM_INTF` |
| 4 | HISTORICAL_LEXM_TF | 25 | 11453 | 3 | `s_m_Update_TN_INVENTORY_HISTORICAL_LEXM_TF` |
| 5 | INVENTORY_NUMS_HISTORICAL | 25 | 11454 | 3 | `s_m_Update_TN_INVENTORY_NUMS_HISTORICAL` |

#### DG_130 — 5 members
- **Sources:** `PO_TN_RANGE, TN_LINE_ORDER, TN_LINE_ORDER11, WRK_TN_LINE_ORDER`
- **Targets:** `CODS_TN_STG, WRK_TN_LINE_ORDER`
- **Lookups:** `EWFM_ORDER, EWFM_ORDER_SEGMENTS, GL_SEG2_PROFIT_CTR, ORDER_NUMBER, PHYS_STRUCT_GEOCODE +6 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TN_LINE_ORDER | 30 | 12110 | 9 | `s_m_Load_CPO_WRK_TN_LINE_ORDER` |
| 2 | LINE_ORDER_Partition1 | 30 | 12111 | 9 | `s_m_Load_CPO_WRK_TN_LINE_ORDER_Partition1` |
| 3 | LINE_ORDER_Partition2 | 30 | 12112 | 9 | `s_m_Load_CPO_WRK_TN_LINE_ORDER_Partition2` |
| 4 | LINE_ORDER_Partition3 | 30 | 12113 | 9 | `s_m_Load_CPO_WRK_TN_LINE_ORDER_Partition3` |
| 5 | LINE_ORDER_Partition4 | 30 | 12114 | 9 | `s_m_Load_CPO_WRK_TN_LINE_ORDER_Partition4` |

#### DG_131 — 5 members
- **Sources:** `F_CDR, VSUM_STAR_SCHEMA_RED`
- **Targets:** `FF_ACCRUSG`
- **Lookups:** `CUSTOMER, F_BILLING_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | VSUM_RED_Unl1 | 21 | 10784 | 7 | `s_m_Load_ACCR_USG_VSUM_RED_Unl1` |
| 2 | VSUM_RED_Unl2 | 21 | 10785 | 7 | `s_m_Load_ACCR_USG_VSUM_RED_Unl2` |
| 3 | VSUM_RED_Unl3 | 21 | 10786 | 7 | `s_m_Load_ACCR_USG_VSUM_RED_Unl3` |
| 4 | VSUM_RED_Unl4 | 21 | 10787 | 7 | `s_m_Load_ACCR_USG_VSUM_RED_Unl4` |
| 5 | VSUM_RED_Unl4Feb | 21 | 10788 | 7 | `s_m_Load_ACCR_USG_VSUM_RED_Unl4Feb` |

#### DG_132 — 5 members
- **Sources:** `ENS_MM_TEMP_KEY_ID, SRC_ENS_MM_TEMP_KEY_ID`
- **Targets:** `ENS_MM_TEMP_KEY_ID`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | id_oms_order | 1 | 7558 | 2 | `s_m_load_stg_ens_mm_key_id_oms_order` |
| 2 | key_id_product | 1 | 7559 | 2 | `s_m_load_stg_ens_mm_key_id_product` |
| 3 | id_product_version | 1 | 7560 | 2 | `s_m_load_stg_ens_mm_key_id_product_version` |
| 4 | id_service_agreement | 1 | 7561 | 2 | `s_m_load_stg_ens_mm_key_id_service_agreement` |
| 5 | id_service_feature | 1 | 7562 | 2 | `s_m_load_stg_ens_mm_key_id_service_feature` |

#### DG_133 — 5 members
- **Sources:** `ADMIN_CI_DOMAIN`
- **Targets:** `CI_DOMAIN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | truncate_epd | 5 | 9342 | 3 | `s_m_truncate_epd` |
| 2 | link_cnct_block | 5 | 9343 | 2 | `s_m_truncate_link_cnct_block` |
| 3 | truncate_link_connections | 5 | 9344 | 3 | `s_m_truncate_link_connections` |
| 4 | truncate_sncs | 5 | 9345 | 3 | `s_m_truncate_sncs` |
| 5 | truncate_tc_components | 5 | 9346 | 3 | `s_m_truncate_tc_components` |

#### DG_134 — 4 members
- **Sources:** `F_END_IN_SERVICE`
- **Targets:** `DSL_UNT_PRD_ACTY, F_END_IN_SERVICE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ACCOUNT_ODS_ID | 1 | 6890 | 3 | `s_m_Update_BILL_ACCOUNT_ODS_ID` |
| 2 | ODS_ID_ENS | 1 | 7001 | 3 | `s_m_Update_ORDER_ODS_ID_ENS` |
| 3 | ZUORA_AND_PPP | 1 | 7002 | 3 | `s_m_Update_ORDER_ODS_ID_ZUORA_AND_PPP` |
| 4 | SALES_ODS_ID | 1 | 7029 | 3 | `s_m_Update_SALES_ODS_ID` |

#### DG_135 — 4 members
- **Sources:** `AE2E_AM_OFFNET_MGR_PREP, AE2E_AM_OFFNET_MGR_PREP1, AE2E_JOB_LOG, WILTEL_OPENCI_STG, WILTEL_OPENCI_STG1`
- **Targets:** `AE2E_AM_OPENCI_PREP, AE2E_JOB_LOG`
- **Lookups:** `AE2E_AM_OPENCI_PREP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AE2E_OPENCI_PREP | 37 | 12863 | 12 | `s_m_LOAD_AE2E_OPENCI_PREP` |
| 2 | OPENCI_PREP_WCD | 37 | 12864 | 12 | `s_m_LOAD_AE2E_OPENCI_PREP_WCD` |
| 3 | OPENCI_PREP_WND | 37 | 12865 | 12 | `s_m_LOAD_AE2E_OPENCI_PREP_WND` |
| 4 | OPENCI_PREP_WNI | 37 | 12866 | 12 | `s_m_LOAD_AE2E_OPENCI_PREP_WNI` |

#### DG_136 — 4 members
- **Sources:** `CDW_LOAD_RULE, CUSTOMER, SERVICE, SERVICE_ATTR, SERVICE_ATTR1`
- **Targets:** `SERVICE_ATTR`
- **Lookups:** `SERVICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ARM_SERVICE_ATTR | 14 | 10106 | 24 | `s_m_Load_ARM_SERVICE_ATTR` |
| 2 | LIMS_SERVICE_ATTR | 16 | 10358 | 24 | `s_m_Load_LIMS_SERVICE_ATTR` |
| 3 | CFS_SERVICE_ATTR | 16 | 10359 | 24 | `s_m_Load_LUMEN_SERVICENOW_CFS_SERVICE_ATTR` |
| 4 | RFS_SERVICE_ATTR | 24 | 11226 | 24 | `s_m_Load_LUMEN_SERVICENOW_RFS_SERVICE_ATTR` |

#### DG_137 — 4 members
- **Sources:** `LINE_ITEM`
- **Targets:** `USOC_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLED_BATCHID_UPD | 2 | 8155 | 2 | `s_m_Load_NETEX_USOC_BILLED_BATCHID_UPD` |
| 2 | BATCHID_UPD_CTL | 2 | 8156 | 2 | `s_m_Load_NETEX_USOC_BILLED_BATCHID_UPD_CTL` |
| 3 | Initial_BATCHID_UPD | 2 | 8157 | 2 | `s_m_Load_NETEX_USOC_BILLED_Initial_BATCHID_UPD` |
| 4 | BATCHID_UPD_CTL | 2 | 8158 | 2 | `s_m_Load_NETEX_USOC_BILLED_Initial_BATCHID_UPD_CTL` |

#### DG_138 — 4 members
- **Sources:** `CIRCUIT_CHARGE_DETAIL, USOC_BILLED`
- **Targets:** `USOC_BILLED`
- **Lookups:** `SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLED_CCD_SAM | 21 | 10852 | 8 | `s_m_Load_NETEX_USOC_BILLED_CCD_SAM` |
| 2 | CCD_SAM_EMEA | 21 | 10853 | 8 | `s_m_Load_NETEX_USOC_BILLED_CCD_SAM_EMEA` |
| 3 | SAM_EMEA_Weekly | 21 | 10854 | 10 | `s_m_Load_NETEX_USOC_BILLED_CCD_SAM_EMEA_Weekly` |
| 4 | CCD_SAM_Weekly | 21 | 10856 | 10 | `s_m_Load_NETEX_USOC_BILLED_CCD_SAM_Weekly` |

#### DG_139 — 4 members
- **Sources:** `ACBALWK, BILLING_ACCOUNT_ATTR`
- **Targets:** `BILLING_ACCOUNT_ATTR, CODS`
- **Lookups:** `BILLING_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_ACCOUNT_ATTR | 10 | 9764 | 10 | `s_m_Load_BART_BILLING_ACCOUNT_ATTR` |
| 2 | BILLING_ACCOUNT_ATTR | 10 | 9769 | 10 | `s_m_Load_CABS_BILLING_ACCOUNT_ATTR` |
| 3 | BILLING_ACCOUNT_ATTR | 12 | 9981 | 10 | `s_m_Load_ENS_BILLING_ACCOUNT_ATTR` |
| 4 | BILLING_ACCOUNT_ATTR | 12 | 10009 | 10 | `s_m_Load_LEXCIS_BILLING_ACCOUNT_ATTR` |

#### DG_140 — 4 members
- **Sources:** `BILLING_ACCOUNT_ATTR, CMF`
- **Targets:** `BILLING_ACCOUNT_ATTR, CODS`
- **Lookups:** `BILLING_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_ACCOUNT_ATTR | 12 | 9972 | 8 | `s_m_Load_CRIS_BILLING_ACCOUNT_ATTR` |
| 2 | BILLING_ACCOUNT_ATTR | 12 | 9990 | 10 | `s_m_Load_IDC_KENAN_BILLING_ACCOUNT_ATTR` |
| 3 | BILLING_ACCOUNT_ATTR | 12 | 9999 | 10 | `s_m_Load_KENANFX_BILLING_ACCOUNT_ATTR` |
| 4 | BILLING_ACCOUNT_ATTR | 12 | 10003 | 10 | `s_m_Load_LATIS_BILLING_ACCOUNT_ATTR` |

#### DG_141 — 4 members
- **Sources:** `DUMMY_NBR_SRC, DUMMY_NBR_SRC1`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Bill_ODS_ID | 1 | 640 | 3 | `s_m_Generate_Control_Merge_Source_Bill_ODS_ID` |
| 2 | CUST_REV_EXTRACT | 1 | 5609 | 9 | `s_m_Load_SWP_F_SFDC_CUST_REV_EXTRACT` |
| 3 | ID_In_FRDA | 1 | 6793 | 3 | `s_m_Reprocess_Missing_BPC_ODS_ID_In_FRDA` |
| 4 | In_FRD_NIBS | 1 | 6794 | 3 | `s_m_Reprocess_Missing_PROD_CD_In_FRD_NIBS` |

#### DG_142 — 4 members
- **Sources:** `PROCESS_CONTROL_MASTER`
- **Targets:** `TGT_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CDP_From_TCDP | 2 | 8004 | 5 | `s_m_Load_CDP_From_TCDP` |
| 2 | From_TCDP_Stg1 | 2 | 8006 | 5 | `s_m_Load_CDP_From_TCDP_Stg1` |
| 3 | From_TCDP_old | 2 | 8008 | 7 | `s_m_Load_CDP_From_TCDP_old` |
| 4 | CDP_From_TCDP | 2 | 8524 | 7 | `s_m_X_Load_CDP_From_TCDP` |

#### DG_143 — 4 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, ORDER_PRODUCT_COMPNT, PRODUCT_COMPNT_INCR_AMT, PRODUCT_COMPNT_INCR_AMT1`
- **Targets:** `CODS, PRODUCT_COMPNT_INCR_AMT`
- **Lookups:** `L3AR_GL_GOV_REV_VALUES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COMPNT_INCR_AMT | 19 | 10624 | 9 | `s_m_Load_ENS_PRODUCT_COMPNT_INCR_AMT` |
| 2 | INCR_AMT_1 | 19 | 10625 | 9 | `s_m_Load_ENS_PRODUCT_COMPNT_INCR_AMT_1` |
| 3 | INCR_AMT_2 | 19 | 10626 | 9 | `s_m_Load_ENS_PRODUCT_COMPNT_INCR_AMT_2` |
| 4 | INCR_AMT_3 | 19 | 10627 | 9 | `s_m_Load_ENS_PRODUCT_COMPNT_INCR_AMT_3` |

#### DG_144 — 4 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP`
- **Targets:** `SAP_ACCRUAL_CHARGE_MJE_EXPORT_FF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CONTRACT_MJE_FF | 27 | 11580 | 2 | `s_m_Load_NETEX_CONTRACT_MJE_FF` |
| 2 | USF_EXPORT_FF | 27 | 11601 | 2 | `s_m_Load_SAP_NETEX_ALLOC_USF_EXPORT_FF` |
| 3 | VOICE_EXPORT_FF | 27 | 11603 | 2 | `s_m_Load_SAP_NETEX_ALLOC_VOICE_EXPORT_FF` |
| 4 | VYVX_EXPORT_FF | 27 | 11605 | 2 | `s_m_Load_SAP_NETEX_ALLOC_VYVX_EXPORT_FF` |

#### DG_145 — 4 members
- **Sources:** `CDW_LOAD_RULE, CUSTOMER, SOURCE_CONTACT, SOURCE_CONTACT1`
- **Targets:** `CODS, SOURCE_CONTACT`
- **Lookups:** `EMPLOYEE, EMPLOYEE_LKP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CORE_SOURCE_CONTACT | 9 | 9648 | 24 | `s_m_Load_CORE_SOURCE_CONTACT` |
| 2 | PROD_SOURCE_CONTACT | 9 | 9697 | 22 | `s_m_Load_PROD_SOURCE_CONTACT` |
| 3 | SDP_SOURCE_CONTACT | 9 | 9713 | 23 | `s_m_Load_SDP_SOURCE_CONTACT` |
| 4 | VANTIVE_SOURCE_CONTACT | 21 | 10922 | 23 | `s_m_Load_VANTIVE_SOURCE_CONTACT` |

#### DG_146 — 4 members
- **Sources:** `PROCESS_PARAMETER`
- **Targets:** `PROCESS_PARAMETER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CTD_OPEN_DT | 1 | 6894 | 3 | `s_m_Update_CTD_OPEN_DT` |
| 2 | TABLES_OPEN_DT | 1 | 7024 | 2 | `s_m_Update_PROCESS_PARAMETER_FOR_DH_TABLES_OPEN_DT` |
| 3 | TABLES_VALUE_DT | 1 | 7025 | 2 | `s_m_Update_PROCESS_PARAMETER_FOR_DH_TABLES_VALUE_DT` |
| 4 | FORECAST_VALUE_DT | 1 | 7026 | 2 | `s_m_Update_PROCESS_PARAMETER_FOR_F_REVENUE_TERM_FORECAST_VALUE_DT` |

#### DG_147 — 4 members
- **Sources:** `DUMMY_STATS`
- **Targets:** `DUMMY_STATS1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUST_INFO_UPD | 1 | 128 | 1 | `s_m_CUST_INFO_UPD` |
| 2 | ORDER_ATTRIB_REV | 1 | 574 | 1 | `s_m_Compute_Stats_DSL_ORDER_CUST_ORDER_ATTRIB_REV` |
| 3 | CUSTOMER_ORDER_PRODUCT | 1 | 575 | 1 | `s_m_Compute_Stats_DSL_ORDER_V_CUSTOMER_ORDER_PRODUCT` |
| 4 | ORDER_PRODUCT_COMPNT | 1 | 576 | 1 | `s_m_Compute_Stats_DSL_ORDER_V_ORDER_PRODUCT_COMPNT` |

#### DG_148 — 4 members
- **Sources:** `DUAL_100, DUAL_NUMBER`
- **Targets:** `TGT_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Connection_Magento_ODBC | 1 | 6828 | 1 | `s_m_Test_Relational_Connection_Magento_ODBC` |
| 2 | Relational_Connection_ODBC | 1 | 6830 | 1 | `s_m_Test_Relational_Connection_ODBC` |
| 3 | Relational_Connection_ODBC2 | 1 | 6831 | 1 | `s_m_Test_Relational_Connection_ODBC2` |
| 4 | Relational_Connection_SQLServer | 1 | 6833 | 1 | `s_m_Test_Relational_Connection_SQLServer` |

#### DG_149 — 4 members
- **Sources:** `ASPEN_VSUM_TBLS, D_CUSTOMER`
- **Targets:** `FF_DA_FCC_REPORT_5MIN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DA5_AUTO | 22 | 10962 | 1 | `s_m_DA5_AUTO` |
| 2 | DA5_MANUAL | 22 | 10963 | 1 | `s_m_DA5_MANUAL` |
| 3 | SW5_AUTO | 22 | 11067 | 1 | `s_m_SW5_AUTO` |
| 4 | SW5_MANUAL | 22 | 11068 | 1 | `s_m_SW5_MANUAL` |

#### DG_150 — 4 members
- **Sources:** `ASPEN_VSUM_TBLS, D_CUSTOMER`
- **Targets:** `FF_DA_FCC_REPORT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DA_AUTO | 22 | 10964 | 2 | `s_m_DA_AUTO` |
| 2 | DA_MANUAL | 22 | 10965 | 2 | `s_m_DA_MANUAL` |
| 3 | SW_AUTO | 22 | 11069 | 2 | `s_m_SW_AUTO` |
| 4 | SW_MANUAL | 22 | 11070 | 2 | `s_m_SW_MANUAL` |

#### DG_151 — 4 members
- **Sources:** `ASG_OCL, ASG_OCL_1, ASG_OCL_2, INVOICE, INVOICE_1 +19 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_CIRCUIT, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_ASG2_MRC | 20 | 10705 | 38 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ASG2_MRC` |
| 2 | ASG2_MRC_CTL | 20 | 10706 | 38 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ASG2_MRC_CTL` |
| 3 | DETAIL_TSC_MRC | 20 | 10754 | 39 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_TSC_MRC` |
| 4 | TSC_MRC_CTL | 20 | 10755 | 39 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_TSC_MRC_CTL` |

#### DG_152 — 4 members
- **Sources:** `INVOICE, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL11, TAX_SURCHARGE_DETAIL`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_SURCHARGE_FACEPAGE | 20 | 10744 | 15 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_SURCHARGE_FACEPAGE` |
| 2 | SURCHARGE_FACEPAGE_CTL | 20 | 10745 | 15 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_SURCHARGE_FACEPAGE_CTL` |
| 3 | DETAIL_TAX_FACEPAGE | 20 | 10748 | 15 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_TAX_FACEPAGE` |
| 4 | TAX_FACEPAGE_CTL | 20 | 10749 | 15 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_TAX_FACEPAGE_CTL` |

#### DG_153 — 4 members
- **Sources:** `JOURNAL_DAILY`
- **Targets:** `FF_PARAMETER_FILE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Delete_Journal_Daily | 2 | 7815 | 5 | `s_m_Delete_Journal_Daily` |
| 2 | Daily_Zero_Day | 2 | 7816 | 5 | `s_m_Delete_Journal_Daily_Zero_Day` |
| 3 | Daily_Next_Day | 2 | 7832 | 2 | `s_m_Generate_Parameter_File_Journal_Daily_Next_Day` |
| 4 | Daily_Zero_Day | 2 | 7833 | 2 | `s_m_Generate_Parameter_File_Journal_Daily_Zero_Day` |

#### DG_154 — 4 members
- **Sources:** `EQUIP_INST, NETWORK_ELEMENT_ATTR`
- **Targets:** `CODS_NETINV, NETWORK_ELEMENT_ATTR`
- **Lookups:** `NETWORK_ELEMENT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ELEMENT_ATTR_ARM | 29 | 11879 | 9 | `s_m_Load_NETWORK_ELEMENT_ATTR_ARM` |
| 2 | ELEMENT_ATTR_GRANITE | 29 | 11880 | 10 | `s_m_Load_NETWORK_ELEMENT_ATTR_GRANITE` |
| 3 | ELEMENT_ATTR_LIMS | 29 | 11881 | 9 | `s_m_Load_NETWORK_ELEMENT_ATTR_LIMS` |
| 4 | ELEMENT_ATTR_TIRKS | 29 | 11882 | 10 | `s_m_Load_NETWORK_ELEMENT_ATTR_TIRKS` |

#### DG_155 — 4 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, ACCRUAL_CHARGE_MJE_EXPORT_SAP1, ACCRUAL_CHARGE_MJE_EXPORT_SAP2`
- **Targets:** `ACCRUAL_CHARGE_MJE_SAP_IMPORT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | EXPORT_SAP_APAC | 27 | 11558 | 10 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_APAC` |
| 2 | EXPORT_SAP_EMEA | 27 | 11559 | 10 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_EMEA` |
| 3 | EXPORT_SAP_LATAM | 27 | 11562 | 10 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_LATAM` |
| 4 | EXPORT_SAP_NA | 27 | 11563 | 10 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_NA` |

#### DG_156 — 4 members
- **Sources:** `DUMMY`
- **Targets:** `FF_XML_TARGET`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FLOW_STATUS_GREEN | 3 | 8971 | 2 | `s_m_SET_VARIABLE_FLOW_STATUS_GREEN` |
| 2 | FLOW_STATUS_RED | 3 | 8972 | 2 | `s_m_SET_VARIABLE_FLOW_STATUS_RED` |
| 3 | STATUS_RECOVERY_GREEN | 3 | 8973 | 2 | `s_m_Set_VARIABLE_FLOW_STATUS_RECOVERY_GREEN` |
| 4 | STATUS_RECOVERY_RED | 3 | 8974 | 2 | `s_m_Set_VARIABLE_FLOW_STATUS_RECOVERY_RED` |

#### DG_157 — 4 members
- **Sources:** `ASL_LOAD_STATUS, PROCESS_PARAMETER`
- **Targets:** `FF_ODS_BILLING_MAX_PARTITIONS, FF_PARAMETER_FILE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | File_Backdated_Load | 5 | 9207 | 4 | `s_m_Generate_Parameter_File_Backdated_Load` |
| 2 | Parameter_File_INVOICES | 5 | 9211 | 4 | `s_m_Generate_Parameter_File_INVOICES` |
| 3 | Load_Curr_Month | 5 | 9212 | 4 | `s_m_Generate_Parameter_File_Initial_Load_Curr_Month` |
| 4 | Load_Prev_Month | 5 | 9213 | 4 | `s_m_Generate_Parameter_File_Initial_Load_Prev_Month` |

#### DG_158 — 4 members
- **Sources:** `PROCESS_CONTROL_MASTER`
- **Targets:** `FF_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Gen_Dyn_Param | 2 | 7785 | 2 | `s_m_CDD_Gen_Dyn_Param` |
| 2 | Gen_Dyn_Param | 2 | 7787 | 2 | `s_m_CD_Gen_Dyn_Param` |
| 3 | Generate_Parameters_AUTO | 2 | 7834 | 2 | `s_m_Generate_Parameters_AUTO` |
| 4 | Generate_Parameters_MANUAL | 2 | 7835 | 2 | `s_m_Generate_Parameters_MANUAL` |

#### DG_159 — 4 members
- **Sources:** `BILLING_PRODUCT_COMPNT, E_INVOICE_FINAL, INVOICE_ITEM, L3AR_BILL_INVOICE_DETAIL_EXT`
- **Targets:** `STG_F_BILLING_ROLLUP_INV_CM, STG_TAXM_INVOICE_FOR_CURR_LOAD`
- **Lookups:** `BILLING_ACCOUNT, CMF, CMF_EXEMPT, CMF_NOTES, DH_GL_BUSINESS_AREA +13 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_CM_0 | 7 | 9464 | 53 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_1_TAXMART_INV_CM_0` |
| 2 | INV_CM_1 | 7 | 9465 | 53 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_1_TAXMART_INV_CM_1` |
| 3 | INV_CM_2 | 7 | 9466 | 53 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_1_TAXMART_INV_CM_2` |
| 4 | INV_CM_3 | 7 | 9467 | 53 | `s_m_LOAD_F_BILLING_ROLLUP_PHASE_1_TAXMART_INV_CM_3` |

#### DG_160 — 4 members
- **Sources:** `INVOICE, LPC_DETAIL, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL1`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_DETAIL_LPC | 20 | 10730 | 19 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_LPC` |
| 2 | DETAIL_LPC_CTL | 20 | 10731 | 19 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_LPC_CTL` |
| 3 | DETAIL_LPC_FACEPAGE | 20 | 10732 | 21 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_LPC_FACEPAGE` |
| 4 | LPC_FACEPAGE_CTL | 20 | 10733 | 21 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_LPC_FACEPAGE_CTL` |

#### DG_161 — 4 members
- **Sources:** `PARTITION_EXCH_CONTROL`
- **Targets:** `TGT_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Index_Stage | 2 | 7842 | 4 | `s_m_Index_Stage` |
| 2 | STAGE_CALL_DETAIL | 2 | 8362 | 4 | `s_m_Load_STAGE_CALL_DETAIL` |
| 3 | CALL_DETAIL_Init | 2 | 8363 | 4 | `s_m_Load_STAGE_CALL_DETAIL_Init` |
| 4 | CALL_DETAIL_Post | 2 | 8364 | 4 | `s_m_Load_STAGE_CALL_DETAIL_Post` |

#### DG_162 — 4 members
- **Sources:** `ASL_LOAD_STATUS, CDMTB_REVENUE_DETAIL, DUMMY_LAST_EXTRACT, DUMMY_TMP, TMP_JOURNAL_LINE +1 more`
- **Targets:** `DUMMY_TGT, FF_LOAD_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | KEY_ID_TEMP | 7 | 9484 | 10 | `s_m_Load_FRD_JRNL_KEY_ID_TEMP` |
| 2 | ID_TEMP_CABS | 7 | 9485 | 10 | `s_m_Load_FRD_JRNL_KEY_ID_TEMP_CABS` |
| 3 | ID_TEMP_MBS | 7 | 9486 | 10 | `s_m_Load_FRD_JRNL_KEY_ID_TEMP_MBS` |
| 4 | ID_TEMP_RJF | 7 | 9487 | 10 | `s_m_Load_FRD_JRNL_KEY_ID_TEMP_RJF` |

#### DG_163 — 4 members
- **Sources:** `FF_PARAMETERS_LOAD_END_TIME`
- **Targets:** `FF_PARAMETERS_LOAD_START_TIME`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_Start_Time | 31 | 12343 | 2 | `s_m_NOE_Update_Parameters_Load_Start_Time` |
| 2 | Load_Start_Time | 31 | 12353 | 2 | `s_m_WORKFLOW_Update_Parameters_Load_Start_Time` |
| 3 | Start_Time_EWFM | 31 | 12354 | 2 | `s_m_WORKFLOW_Update_Parameters_Load_Start_Time_EWFM` |
| 4 | Start_Time_RSI | 31 | 12355 | 2 | `s_m_WORKFLOW_Update_Parameters_Load_Start_Time_RSI` |

#### DG_164 — 4 members
- **Sources:** `TN_LOOKUP_DELTA_MERGE`
- **Targets:** `DB_LINK_OUT, TN_LOOKUP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_TN_LOOKUP | 32 | 12421 | 4 | `s_m_Load_TN_LOOKUP` |
| 2 | SLDB_ONE_TIME | 32 | 12422 | 4 | `s_m_Load_TN_LOOKUP_ALL_SOURCES_BUT_SLDB_ONE_TIME` |
| 3 | TN_LOOKUP_CPO | 32 | 12423 | 4 | `s_m_Load_TN_LOOKUP_CPO` |
| 4 | ONE_TIME_UPDATE | 32 | 12424 | 4 | `s_m_Load_TN_LOOKUP_SLDB_ONE_TIME_UPDATE` |

#### DG_165 — 4 members
- **Sources:** `FF_GFS_LAT_LONG_LKP, GFS_LAT_LONG_LKP`
- **Targets:** `GFS_LAT_LONG_LKP, GFS_LAT_LONG_LKP_UPD`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MKT_REG_DIV | 2 | 8498 | 10 | `s_m_Update_GFS_LAT_LONG_LKP_MKT_REG_DIV` |
| 2 | DIV_File1_2018 | 2 | 8500 | 15 | `s_m_Update_GFS_LAT_LONG_LKP_MKT_REG_DIV_File1_2018` |
| 3 | 2018_tgt_load | 2 | 8501 | 15 | `s_m_Update_GFS_LAT_LONG_LKP_MKT_REG_DIV_File1_2018_tgt_load` |
| 4 | DIV_File2_2018 | 2 | 8502 | 15 | `s_m_Update_GFS_LAT_LONG_LKP_MKT_REG_DIV_File2_2018` |

#### DG_166 — 4 members
- **Sources:** `FF_MMS_FACT`
- **Targets:** `F_CDR`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, D_CARRIER, D_CLNDR, D_CUSTOMER, D_DEST_TYPE +9 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MMS_Fact_Load | 17 | 10529 | 18 | `s_m_MMS_Fact_Load` |
| 2 | Load_Scenario_A | 17 | 10530 | 18 | `s_m_MMS_Fact_Load_Scenario_A` |
| 3 | Load_Scenario_B | 17 | 10531 | 18 | `s_m_MMS_Fact_Load_Scenario_B` |
| 4 | Load_Scenario_C | 17 | 10532 | 18 | `s_m_MMS_Fact_Load_Scenario_C` |

#### DG_167 — 4 members
- **Sources:** `D_TAXMART_PERIOD, TR_AUTOMATION_REPORT_SQL`
- **Targets:** `DYNAMIC_FILE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MVM_LOG_REPORT | 12 | 9938 | 2 | `s_m_LOAD_MVM_LOG_REPORT` |
| 2 | STATE_TR_REPORT | 12 | 9949 | 2 | `s_m_LOAD_TAX_TYPE_BY_STATE_TR_REPORT` |
| 3 | TR_RPT_CTL | 12 | 9950 | 2 | `s_m_LOAD_TAX_TYPE_BY_STATE_TR_RPT_CTL` |
| 4 | TR_RPT_FLVLT | 12 | 9951 | 2 | `s_m_LOAD_TAX_TYPE_BY_STATE_TR_RPT_FLVLT` |

#### DG_168 — 4 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT`
- **Targets:** `NETEX_ALLOCATION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETEX_ALLOC_FF | 25 | 11394 | 3 | `s_m_Load_NETEX_ALLOC_FF` |
| 2 | L3_USF_FF | 25 | 11396 | 3 | `s_m_Load_NETEX_ALLOC_L3_USF_FF` |
| 3 | ALLOC_USF_FF | 25 | 11397 | 3 | `s_m_Load_NETEX_ALLOC_USF_FF` |
| 4 | ALLOC_VOICE_FF | 25 | 11399 | 3 | `s_m_Load_NETEX_ALLOC_VOICE_FF` |

#### DG_169 — 4 members
- **Sources:** `TABLE_NOTES_LOG, TABLE_NOTES_LOG_MAX_CREATION_TIME`
- **Targets:** `FF_MAX_CREATION_TS_NOTES_LOG, TABLE_NOTES_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NOTES_LOG_HIST | 1 | 5832 | 4 | `s_m_Load_TABLE_NOTES_LOG_HIST` |
| 2 | LOG_HIST_1 | 1 | 5833 | 4 | `s_m_Load_TABLE_NOTES_LOG_HIST_1` |
| 3 | LOG_HIST_2 | 1 | 5834 | 4 | `s_m_Load_TABLE_NOTES_LOG_HIST_2` |
| 4 | LOG_HIST_3 | 1 | 5835 | 4 | `s_m_Load_TABLE_NOTES_LOG_HIST_3` |

#### DG_170 — 4 members
- **Sources:** `ECCKT`
- **Targets:** `NOT_NULL_VALIDATION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Not_Null_validation | 34 | 12618 | 5 | `s_m_Load_NETEX_Not_Null_validation` |
| 2 | before_ecckt_load | 34 | 12625 | 5 | `s_m_Load_Not_NUll_Validdation_before_ecckt_load` |
| 3 | after_ecckt_load | 34 | 12626 | 5 | `s_m_Load_Not_Null_Validation_after_ecckt_load` |
| 4 | ecckt_load_PBC | 34 | 12627 | 5 | `s_m_Load_Not_Null_Validation_after_ecckt_load_PBC` |

#### DG_171 — 4 members
- **Sources:** `AE2E_UNIX_JOB_LOG`
- **Targets:** `TARGET_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ODW_STG_CHECK | 37 | 12851 | 1 | `s_m_AE2E_UNIX_ODW_STG_CHECK` |
| 2 | STG_LOG_CHECK | 37 | 12853 | 1 | `s_m_CV_ACTIVE_STG_LOG_CHECK` |
| 3 | STG_LOG_CHECK | 37 | 12854 | 1 | `s_m_CV_ARCHIVE_STG_LOG_CHECK` |
| 4 | XLINK_LOG_CHECK | 37 | 12879 | 1 | `s_m_XLINK_LOG_CHECK` |

#### DG_172 — 4 members
- **Sources:** `TN_LINE_ORDER`
- **Targets:** `CODS_TN, TN_LINE_ORDER`
- **Lookups:** `ADDRESS, GL_SEG2_PROFIT_CTR, L3AR_GL_PROFIT_CENTER, PROFIT_CENTER_MAPPING`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ONE_TIME_Load | 4 | 9160 | 2 | `s_m_Update_TN_LINE_ORDER_NS_ONE_TIME_Load` |
| 2 | ONE_TIME_Load1 | 4 | 9161 | 2 | `s_m_Update_TN_LINE_ORDER_NS_ONE_TIME_Load1` |
| 3 | ONE_TIME_Load | 4 | 9162 | 2 | `s_m_Update_TN_LINE_ORDER_SLDB_ONE_TIME_Load` |
| 4 | ONE_TIME_Load1 | 4 | 9163 | 2 | `s_m_Update_TN_LINE_ORDER_SLDB_ONE_TIME_Load1` |

#### DG_173 — 4 members
- **Sources:** `AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG, WILTEL_OFFNET_MGR_INVENTORY`
- **Targets:** `AE2E_AM_OFFNET_MGR_PREP, AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG`
- **Lookups:** `AE2E_SYSTEM`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ONM_PREP_WCD | 29 | 11829 | 7 | `s_m_AE2E_ONM_PREP_WCD` |
| 2 | ONM_PREP_WCI | 29 | 11836 | 7 | `s_m_LOAD_AE2E_ONM_PREP_WCI` |
| 3 | ONM_PREP_WND | 29 | 11837 | 7 | `s_m_LOAD_AE2E_ONM_PREP_WND` |
| 4 | ONM_PREP_WNI | 29 | 11838 | 7 | `s_m_LOAD_AE2E_ONM_PREP_WNI` |

#### DG_174 — 4 members
- **Sources:** `OOR_ASR, OOR_SALI, OOR_SALI1, ORDERXMLDATA, ORDERXMLDATA1`
- **Targets:** `OOR_SALI`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | OOR_SALI_ARI | 2 | 8604 | 28 | `s_m_load_OOR_SALI_ARI` |
| 2 | OOR_SALI_EUSA | 2 | 8605 | 28 | `s_m_load_OOR_SALI_EUSA` |
| 3 | OOR_SALI_MSL | 2 | 8606 | 28 | `s_m_load_OOR_SALI_MSL` |
| 4 | OOR_SALI_SES | 2 | 8607 | 28 | `s_m_load_OOR_SALI_SES` |

#### DG_175 — 4 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, CUSTOMER_ORDER_PRODUCT1, CUSTOMER_ORDER_PRODUCT11`
- **Targets:** `CODS, CUSTOMER_ORDER_PRODUCT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_BLUEMARBLE | 1 | 6992 | 5 | `s_m_Update_ODS_CUSTOMER_ORDER_PRODUCT_BLUEMARBLE` |
| 2 | PRODUCT_ENS_MM | 1 | 6996 | 5 | `s_m_Update_ODS_CUSTOMER_ORDER_PRODUCT_ENS_MM` |
| 3 | ORDER_PRODUCT_QF | 1 | 6998 | 5 | `s_m_Update_ODS_CUSTOMER_ORDER_PRODUCT_QF` |
| 4 | ORDER_PRODUCT_RSOR | 1 | 6999 | 5 | `s_m_Update_ODS_CUSTOMER_ORDER_PRODUCT_RSOR` |

#### DG_176 — 4 members
- **Sources:** `D_CUSTOMER, D_TRUNKGROUP, D_TRUNKGROUP1, D_TRUNKGROUP11, F_HOUR_TG_STATS +1 more`
- **Targets:** `FF_5MIN_INBOUND_OUTBOUND`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Outbound_Report_BLUE | 22 | 10954 | 5 | `s_m_Create_5Min_Inbound_Outbound_Report_BLUE` |
| 2 | Outbound_Report_ENASS | 22 | 10955 | 5 | `s_m_Create_5Min_Inbound_Outbound_Report_ENASS` |
| 3 | NASS_ISS_GSX | 22 | 10956 | 6 | `s_m_Create_5Min_Inbound_Outbound_Report_NASS_ISS_GSX` |
| 4 | NASS_ISS_NBS | 22 | 10957 | 6 | `s_m_Create_5Min_Inbound_Outbound_Report_NASS_ISS_NBS` |

#### DG_177 — 4 members
- **Sources:** `WFVARS, WFVARS1, WFVARS2`
- **Targets:** `DOKUVIZ, WFVARS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Partition_Group_1 | 1 | 6456 | 11 | `s_m_Load_WFVARS_Partition_Group_1` |
| 2 | Partition_Group_2 | 1 | 6457 | 11 | `s_m_Load_WFVARS_Partition_Group_2` |
| 3 | Partition_Group_3 | 1 | 6458 | 11 | `s_m_Load_WFVARS_Partition_Group_3` |
| 4 | Partition_Group_4 | 1 | 6459 | 11 | `s_m_Load_WFVARS_Partition_Group_4` |

#### DG_178 — 4 members
- **Sources:** `ACCRUAL_INSTANCE, ECCKT, NETEX_REVENUE_MATCH_OVR, NETEX_REVENUE_MATCH_OVR1, NETEX_REVENUE_MATCH_OVR11 +1 more`
- **Targets:** `DSL_AIM, NETEX_REVENUE_MATCH_OVR`
- **Lookups:** `BILLING_ACCOUNT, CUSTOMER, NETEX_REVENUE_MATCH_OVR`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_MATCH_OVR | 21 | 10824 | 27 | `s_m_Load_NETEX_REVENUE_MATCH_OVR` |
| 2 | REVENUE_MATCH_OVR2 | 21 | 10825 | 28 | `s_m_Load_NETEX_REVENUE_MATCH_OVR2` |
| 3 | MATCH_OVR_EMEA | 21 | 10826 | 28 | `s_m_Load_NETEX_REVENUE_MATCH_OVR_EMEA` |
| 4 | MATCH_OVR_LATAM | 21 | 10827 | 28 | `s_m_Load_NETEX_REVENUE_MATCH_OVR_LATAM` |

#### DG_179 — 4 members
- **Sources:** `F_BILLING_ROLLUP`
- **Targets:** `DUMMY_TGT, F_BILLED_REVENUE_MNTH`
- **Lookups:** `D_COMBINED_COMPANY_CD, F_FEDERAL_TAX_EXEMPTIONS, STATE_VALUES, U_CHARGE_ID_MAP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_MNTH_125 | 16 | 10286 | 17 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_125` |
| 2 | REVENUE_MNTH_133 | 16 | 10288 | 17 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_133` |
| 3 | REVENUE_MNTH_166 | 16 | 10289 | 17 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_166` |
| 4 | REVENUE_MNTH_624 | 16 | 10295 | 17 | `s_m_LOAD_F_BILLED_REVENUE_MNTH_624` |

#### DG_180 — 4 members
- **Sources:** `F_BILLING_ROLLUP`
- **Targets:** `DUMMY_TGT, F_BILLED_REVENUE_QRTR`
- **Lookups:** `D_COMBINED_COMPANY_CD, F_FEDERAL_TAX_EXEMPTIONS, STATE_VALUES, U_CHARGE_ID_MAP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_QRTR_125 | 16 | 10301 | 17 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_125` |
| 2 | REVENUE_QRTR_133 | 16 | 10303 | 17 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_133` |
| 3 | REVENUE_QRTR_166 | 16 | 10304 | 17 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_166` |
| 4 | REVENUE_QRTR_624 | 16 | 10310 | 17 | `s_m_LOAD_F_BILLED_REVENUE_QRTR_624` |

#### DG_181 — 4 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_QRTR, BILLED_REVENUE_RGLTRY_VW_QRTR1, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2 +3 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_QRTR, TAXMART`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_QRTR_169 | 25 | 11336 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_169` |
| 2 | REVENUE_QRTR_175 | 25 | 11337 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_175` |
| 3 | REVENUE_QRTR_273 | 25 | 11340 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_273` |
| 4 | REVENUE_QRTR_641 | 25 | 11342 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_641` |

#### DG_182 — 4 members
- **Sources:** `F_BILLING_ROLLUP`
- **Targets:** `DUMMY_TGT, F_BILLED_REVENUE_YR`
- **Lookups:** `D_COMBINED_COMPANY_CD, F_FEDERAL_TAX_EXEMPTIONS, STATE_VALUES, U_CHARGE_ID_MAP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_125 | 16 | 10315 | 17 | `s_m_LOAD_F_BILLED_REVENUE_YR_125` |
| 2 | REVENUE_YR_133 | 16 | 10317 | 17 | `s_m_LOAD_F_BILLED_REVENUE_YR_133` |
| 3 | REVENUE_YR_166 | 16 | 10318 | 17 | `s_m_LOAD_F_BILLED_REVENUE_YR_166` |
| 4 | REVENUE_YR_624 | 16 | 10324 | 17 | `s_m_LOAD_F_BILLED_REVENUE_YR_624` |

#### DG_183 — 4 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_YR, BILLED_REVENUE_RGLTRY_VW_YR1, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2 +3 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_YR, TAXMART`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_169 | 25 | 11352 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_169` |
| 2 | REVENUE_YR_175 | 25 | 11353 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_175` |
| 3 | REVENUE_YR_273 | 25 | 11356 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_273` |
| 4 | REVENUE_YR_641 | 25 | 11358 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_641` |

#### DG_184 — 4 members
- **Sources:** `VP_ECCKT_REV_MATCH, VP_ECCKT_REV_MATCH1, VP_EXPENSE_DETAIL`
- **Targets:** `DSL_AML_REF, VP_ECCKT_REV_MATCH`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REV_MATCH_CYXTERA | 3 | 8949 | 10 | `s_m_Load_VP_ECCKT_REV_MATCH_CYXTERA` |
| 2 | REV_MATCH_DRT | 3 | 8950 | 10 | `s_m_Load_VP_ECCKT_REV_MATCH_DRT` |
| 3 | REV_MATCH_ECCKT | 3 | 8951 | 10 | `s_m_Load_VP_ECCKT_REV_MATCH_ECCKT` |
| 4 | MATCH_EXPENSE_DETAIL | 3 | 9024 | 10 | `s_m_load_VP_ECCKT_REV_MATCH_EXPENSE_DETAIL` |

#### DG_185 — 4 members
- **Sources:** `SERVICE, SERVICE_RELATIONSHIP`
- **Targets:** `SERVICE_RELATIONSHIP`
- **Lookups:** `SERVICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RM_SERVICE_RELATIONSHIP | 25 | 11378 | 10 | `s_m_Load_AMDOCS_RM_SERVICE_RELATIONSHIP` |
| 2 | USM_SERVICE_RELATIONSHIP | 25 | 11379 | 10 | `s_m_Load_AMDOCS_USM_SERVICE_RELATIONSHIP` |
| 3 | ARM_SERVICE_RELATIONSHIP | 25 | 11380 | 10 | `s_m_Load_ARM_SERVICE_RELATIONSHIP` |
| 4 | RFS_SERVICE_RELATIONSHIP | 25 | 11391 | 10 | `s_m_Load_LUMEN_SERVICENOW_RFS_SERVICE_RELATIONSHIP` |

#### DG_186 — 4 members
- **Sources:** `ETL_PARAMETER, SRC_CDW_COMMON`
- **Targets:** `CDW_COMMON_ETL_PARAMETER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RUN_UPDATE_CABS | 4 | 9059 | 1 | `s_m_LOAD_ETL_PARAMETER_POST_RUN_UPDATE_CABS` |
| 2 | PARAMETER_PREV_MONTH | 4 | 9060 | 1 | `s_m_LOAD_ETL_PARAMETER_PREV_MONTH` |
| 3 | PREV_MONTH_CABS | 4 | 9061 | 1 | `s_m_LOAD_ETL_PARAMETER_PREV_MONTH_CABS` |
| 4 | POST_RUN_UPDATE | 4 | 9062 | 1 | `s_m_LOAD_ETL_PARAMETER_PREV_MONTH_POST_RUN_UPDATE` |

#### DG_187 — 4 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_LATAM, ACCRUAL_CHARGE_MJE_EXPORT_SAP`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP_ADJ`
- **Lookups:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SAP_AMT_ADJ | 27 | 11564 | 4 | `s_m_Load_ACCRUAL_CUST_EQUIP_MJE_SAP_AMT_ADJ` |
| 2 | TAILS_AMT_ADJ | 27 | 11575 | 4 | `s_m_Load_LATAM_NETEX_ALLOC_TAILS_AMT_ADJ` |
| 3 | DAT_AMT_ADJ | 27 | 11578 | 4 | `s_m_Load_NETEX_ALLOC_DAT_AMT_ADJ` |
| 4 | ALLOC_AMT_ADJ | 27 | 11640 | 4 | `s_m_Load_VOICE_NETEX_ALLOC_AMT_ADJ` |

#### DG_188 — 4 members
- **Sources:** `AR_TRXN_LINE_DIST_JL, DUMMY_NBR_SRC`
- **Targets:** `FF_DUMMY, FF_LOAD_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SAP_TMP_ID | 1 | 1059 | 6 | `s_m_Load_AR_ACCRUAL_DETAIL_JL_SAP_TMP_ID` |
| 2 | SAP_TMP_ID | 1 | 1074 | 6 | `s_m_Load_AR_TRXN_LINE_DIST_JL_SAP_TMP_ID` |
| 3 | JL_TMP_ID | 1 | 2034 | 6 | `s_m_Load_DEFERRED_REVENUE_BALANCE_JL_TMP_ID` |
| 4 | SAP_TMP_ID | 1 | 3224 | 6 | `s_m_Load_JOURNAL_LINE_SL_DIST_SAP_TMP_ID` |

#### DG_189 — 4 members
- **Sources:** `COMPONENT, MEASUREMENT, NE, NE_COMP, NE_COMP_TYPE`
- **Targets:** `ASPEN, F_RAW_TG_STATS`
- **Lookups:** `D_CLNDR, D_SWITCH, D_TRUNKGROUP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STATS_NOCM_CST | 17 | 10481 | 9 | `s_m_Load_F_RAW_TG_STATS_NOCM_CST` |
| 2 | STATS_NOCM_EST | 17 | 10482 | 9 | `s_m_Load_F_RAW_TG_STATS_NOCM_EST` |
| 3 | STATS_NOCM_GMT | 17 | 10483 | 9 | `s_m_Load_F_RAW_TG_STATS_NOCM_GMT` |
| 4 | STATS_NOCM_PST | 17 | 10484 | 9 | `s_m_Load_F_RAW_TG_STATS_NOCM_PST` |

#### DG_190 — 4 members
- **Sources:** `CDN_ORDERS_IN`
- **Targets:** `CDN_IL, URL_PREFIX_DIM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STREAM_ERROR_ROLLUP | 1 | 810 | 2 | `s_m_LOAD_STREAM_ERROR_ROLLUP` |
| 2 | STREAM_TAB_ANALYZE | 1 | 824 | 25 | `s_m_LOAD_STREAM_TAB_ANALYZE` |
| 3 | STREAM_USAGE_ROLLUP | 1 | 825 | 2 | `s_m_LOAD_STREAM_USAGE_ROLLUP` |
| 4 | USAGE_ROLLUP_OPTIMISED | 1 | 826 | 2 | `s_m_LOAD_STREAM_USAGE_ROLLUP_OPTIMISED` |

#### DG_191 — 4 members
- **Sources:** `PHYS_STRUCT, PHYS_STRUCT_BUILDING`
- **Targets:** `PHYS_STRUCT_BUILDING, WFMIMP1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STRUCT_BUILDING_GFSCALL | 29 | 11887 | 7 | `s_m_Load_PHYS_STRUCT_BUILDING_GFSCALL` |
| 2 | BUILDING_GFSCALL_1 | 29 | 11888 | 7 | `s_m_Load_PHYS_STRUCT_BUILDING_GFSCALL_1` |
| 3 | BUILDING_GFSCALL_2 | 29 | 11889 | 7 | `s_m_Load_PHYS_STRUCT_BUILDING_GFSCALL_2` |
| 4 | BUILDING_GFSCALL_3 | 29 | 11890 | 7 | `s_m_Load_PHYS_STRUCT_BUILDING_GFSCALL_3` |

#### DG_192 — 4 members
- **Sources:** `LOCATION, PHYS_STRUCT`
- **Targets:** `CODS_NETINV, PHYS_STRUCT`
- **Lookups:** `PHYS_STRUCT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STRUCT_LIMS_AISLE | 4 | 9127 | 10 | `s_m_Load_PHYS_STRUCT_LIMS_AISLE` |
| 2 | STRUCT_LIMS_BAY | 4 | 9128 | 10 | `s_m_Load_PHYS_STRUCT_LIMS_BAY` |
| 3 | STRUCT_TIRKS_BAY | 4 | 9129 | 10 | `s_m_Load_PHYS_STRUCT_TIRKS_BAY` |
| 4 | STRUCT_TIRKS_FLOOR | 4 | 9130 | 10 | `s_m_Load_PHYS_STRUCT_TIRKS_FLOOR` |

#### DG_193 — 4 members
- **Sources:** `DUMMY, DUMMY2, SOURCE_TABLE_RECORD_COUNT, SOURCE_TABLE_RECORD_COUNT2`
- **Targets:** `DUMMY, SOURCE_TABLE_RECORD_COUNT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TABLE_COUNT_LKP | 1 | 6329 | 20 | `s_m_Load_VALIDATE_TABLE_COUNT_LKP` |
| 2 | COUNT_LKP_DLM | 1 | 6330 | 20 | `s_m_Load_VALIDATE_TABLE_COUNT_LKP_DLM` |
| 3 | TABLE_COUNT_STG | 1 | 6331 | 20 | `s_m_Load_VALIDATE_TABLE_COUNT_STG` |
| 4 | COUNT_STG_DLM | 1 | 6332 | 20 | `s_m_Load_VALIDATE_TABLE_COUNT_STG_DLM` |

#### DG_194 — 4 members
- **Sources:** `CKT_ORDER, CKT_TRACKING, DESIGN_LAYOUT, TBLCIRCUITS_TST`
- **Targets:** `TBLCIRCUITS_TST`
- **Lookups:** `ALIAS_VENDOR, CUSTOMER_DICT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Tblcircuits_tst1_1 | 2 | 8403 | 10 | `s_m_Load_Tblcircuits_tst1_1` |
| 2 | Load_Tblcircuits_tst2 | 2 | 8404 | 10 | `s_m_Load_Tblcircuits_tst2` |
| 3 | Load_Tblcircuits_tst3 | 2 | 8405 | 10 | `s_m_Load_Tblcircuits_tst3` |
| 4 | Load_Tblcircuits_tst4 | 2 | 8406 | 10 | `s_m_Load_Tblcircuits_tst4` |

#### DG_195 — 4 members
- **Sources:** `USOC_BILLED`
- **Targets:** `USOC_BILLED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | USOC_BILLED_SAM | 1 | 6881 | 2 | `s_m_Upd_NETEX_USOC_BILLED_SAM` |
| 2 | BILLED_SAM_EMEA | 1 | 6882 | 2 | `s_m_Upd_NETEX_USOC_BILLED_SAM_EMEA` |
| 3 | ODS_ID_SAM | 1 | 7033 | 3 | `s_m_Update_SID_ODS_ID_SAM` |
| 4 | ID_SAM_EMEA | 1 | 7034 | 3 | `s_m_Update_SID_ODS_ID_SAM_EMEA` |

#### DG_196 — 4 members
- **Sources:** `DSS_CIRCUIT`
- **Targets:** `DSS_CIRCUIT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | child_ind_recursive | 1 | 7207 | 3 | `s_m_dss_circuit_update_div_child_ind_recursive` |
| 2 | child_ind_recursive1 | 1 | 7208 | 3 | `s_m_dss_circuit_update_div_child_ind_recursive1` |
| 3 | child_ind_recursive11 | 1 | 7209 | 3 | `s_m_dss_circuit_update_div_child_ind_recursive11` |
| 4 | child_ind_recursive12 | 1 | 7210 | 3 | `s_m_dss_circuit_update_div_child_ind_recursive12` |

#### DG_197 — 4 members
- **Sources:** `STG_CONTACT`
- **Targets:** `LAST_EXTRACT`
- **Lookups:** `DSS_OMS_ORDER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | endpnt_li_single | 3 | 8991 | 4 | `s_m_cache_endpnt_li_single` |
| 2 | endpnt_parm_single | 3 | 8993 | 4 | `s_m_cache_endpnt_parm_single` |
| 3 | cache_li_single | 3 | 8995 | 4 | `s_m_cache_li_single` |
| 4 | cache_parm_mult | 3 | 8996 | 4 | `s_m_cache_parm_mult` |

#### DG_198 — 3 members
- **Sources:** `STG_BAN_PARENT_CHILD_REL, STG_BAN_PARENT_CHILD_REL1, SUPPLIER_BILLING_ACCOUNT`
- **Targets:** `CODS_NETEX, CODS_NETEX_STG, STG_BAN_PARENT_CHILD_REL, SUPPLIER_BILLING_ACCOUNT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ACCT_ODS_ID | 1 | 7623 | 14 | `s_m_upd_CURRENT_SUPP_BILL_ACCT_ODS_ID` |
| 2 | ODS_ID_EMEA | 1 | 7624 | 14 | `s_m_upd_CURRENT_SUPP_BILL_ACCT_ODS_ID_EMEA` |
| 3 | ID_SAM_LATAM | 1 | 7625 | 14 | `s_m_upd_CURRENT_SUPP_BILL_ACCT_ODS_ID_SAM_LATAM` |

#### DG_199 — 3 members
- **Sources:** `DH_GL_CO_ACCT_PROD_XREF, F_JOURNAL_SUMMARY`
- **Targets:** `DH_GL_CO_ACCT_PROD_XREF, FF_DEFAULT_RECORDS`
- **Lookups:** `DH_GL_CO_ACCT_PROD, GL_PERIOD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ACCT_PROD_XREF | 8 | 9536 | 22 | `s_m_Load_DH_GL_CO_ACCT_PROD_XREF` |
| 2 | XREF_CURR_MNTH | 8 | 9537 | 22 | `s_m_Load_DH_GL_CO_ACCT_PROD_XREF_CURR_MNTH` |
| 3 | XREF_NEXT_MNTH | 8 | 9538 | 22 | `s_m_Load_DH_GL_CO_ACCT_PROD_XREF_NEXT_MNTH` |

#### DG_200 — 3 members
- **Sources:** `SERVICE`
- **Targets:** `SERVICE`
- **Lookups:** `ASSET_PRODUCT_COMPNT, BILLING_ACCOUNT, SERVICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AMDOCS_RM_SERVICE | 13 | 10035 | 10 | `s_m_Load_AMDOCS_RM_SERVICE` |
| 2 | Load_ARM_SERVICE | 13 | 10038 | 10 | `s_m_Load_ARM_SERVICE` |
| 3 | SERVICENOW_RFS_SERVICE | 23 | 11133 | 10 | `s_m_Load_LUMEN_SERVICENOW_RFS_SERVICE` |

#### DG_201 — 3 members
- **Sources:** `AE2E_AMT_STG, AE2E_AMT_STG1, AE2E_AMT_STG11, AE2E_AMT_STG111, AE2E_ENDSTATE_GRANITE_PREP +4 more`
- **Targets:** `AE2E_AMT_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AMT_DIS_PREP | 3 | 8703 | 18 | `s_m_AE2E_UNITY_AMT_DIS_PREP` |
| 2 | NETDIS_AMT_PREP | 3 | 8787 | 18 | `s_m_Load_AE2E_UNITY_NETDIS_AMT_PREP` |
| 3 | NETINS_AMT_PREP | 3 | 8789 | 18 | `s_m_Load_AE2E_UNITY_NETINS_AMT_PREP` |

#### DG_202 — 3 members
- **Sources:** `OMS_ORDER`
- **Targets:** `DUMMY_TGT_CABS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ARPU_CHARGE_STG | 2 | 7956 | 1 | `s_m_Load_ARPU_CHARGE_STG` |
| 2 | RC_SCB_ORDERS | 2 | 7988 | 1 | `s_m_Load_CABS_RC_SCB_ORDERS` |
| 3 | SCB_CHARGE_STG | 2 | 8292 | 1 | `s_m_Load_RC_SCB_CHARGE_STG` |

#### DG_203 — 3 members
- **Sources:** `STG_CIRCUIT_ASG_TSC_ALLOC, SUPPLIER_BILLING_ACCOUNT, SUPPLIER_BILLING_ACCOUNT1, SUPPLIER_CIRCUIT, SUPPLIER_CIRCUIT1 +1 more`
- **Targets:** `CODS_NETEX, SUPPLIER_CIRCUIT`
- **Lookups:** `SUPPLIER_DISPUTE_ACTIVITY, SUPPLIER_INVOICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASG_AMT_SAM | 18 | 10582 | 17 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ASG_AMT_SAM` |
| 2 | AMT_SAM_EMEA | 18 | 10583 | 17 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ASG_AMT_SAM_EMEA` |
| 3 | AMT_SAM_LATAM | 18 | 10584 | 17 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ASG_AMT_SAM_LATAM` |

#### DG_204 — 3 members
- **Sources:** `ASL_LOAD_STATUS, ASL_LOAD_STATUS1`
- **Targets:** `ASL_LOAD_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASL_Load_Status | 1 | 6754 | 3 | `s_m_Recovery_Check_ASL_Load_Status` |
| 2 | ORDERS__C | 1 | 6755 | 3 | `s_m_Recovery_Check_ASL_Load_Status_PROVISIONING_ORDERS__C` |
| 3 | status_BPC_CRIS | 31 | 12350 | 4 | `s_m_Update_ASL_load_status_BPC_CRIS` |

#### DG_205 — 3 members
- **Sources:** `DUAL`
- **Targets:** `ASL_LOAD_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASL_Load_Status | 30 | 12200 | 3 | `s_m_Recovery_Reset_ASL_Load_Status` |
| 2 | ASL_Load_Status | 30 | 12201 | 3 | `s_m_Recovery_Update_ASL_Load_Status` |
| 3 | ORDERS__C | 30 | 12202 | 3 | `s_m_Recovery_Update_ASL_Load_Status_PROVISIONING_ORDERS__C` |

#### DG_206 — 3 members
- **Sources:** `BATCH_FILE_MAP`
- **Targets:** `TGT_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BATCH_FILE_MAP | 3 | 8719 | 1 | `s_m_Check_BATCH_FILE_MAP` |
| 2 | FILE_MAP_KenanIDC | 3 | 8720 | 1 | `s_m_Check_BATCH_FILE_MAP_KenanIDC` |
| 3 | MAP_Vero_Files | 3 | 8721 | 1 | `s_m_Check_BATCH_FILE_MAP_Vero_Files` |

#### DG_207 — 3 members
- **Sources:** `DISPUTE_BULK_UPLOAD, NETEX_BATCH_LOG`
- **Targets:** `CODS_NETEX, NETEX_BATCH_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BATCH_LOG_SAM | 2 | 8135 | 10 | `s_m_Load_NETEX_BATCH_LOG_SAM` |
| 2 | LOG_SAM_EMEA | 2 | 8136 | 10 | `s_m_Load_NETEX_BATCH_LOG_SAM_EMEA` |
| 3 | LOG_SAM_LATAM | 2 | 8137 | 10 | `s_m_Load_NETEX_BATCH_LOG_SAM_LATAM` |

#### DG_208 — 3 members
- **Sources:** `LINE_ITEM, LINE_ITEM_DTL, LINE_ITEM_JUR_DTL, USOC_BILLED`
- **Targets:** `CODS_NETEX, USOC_BILLED`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, VVREF`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLED_ASG_Incremental | 21 | 10846 | 13 | `s_m_Load_NETEX_USOC_BILLED_ASG_Incremental` |
| 2 | ASG_Incremental_CTL | 21 | 10847 | 13 | `s_m_Load_NETEX_USOC_BILLED_ASG_Incremental_CTL` |
| 3 | TYPE_ASG_Incremental | 21 | 10860 | 13 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_ASG_Incremental` |

#### DG_209 — 3 members
- **Sources:** `USOC_BILLED`
- **Targets:** `CODS_NETEX, USOC_BILLED`
- **Lookups:** `SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLED_CAD_SAM | 21 | 10849 | 10 | `s_m_Load_NETEX_USOC_BILLED_CAD_SAM` |
| 2 | CAD_SAM_LATAM | 21 | 10851 | 10 | `s_m_Load_NETEX_USOC_BILLED_CAD_SAM_LATAM` |
| 3 | INVOICES_SAM_LATAM | 24 | 11300 | 5 | `s_m_Upd_NETEX_USOC_BILLED_OUTDATED_INVOICES_SAM_LATAM` |

#### DG_210 — 3 members
- **Sources:** `LEGACY_CTL_BILLING_STG, LEGACY_CTL_BILLING_STG1`
- **Targets:** `FF_LOAD_STATUS, F_TAXES_BILLED, TAXMART`
- **Lookups:** `D_TAXMART_PERIOD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_STG_CABS | 13 | 10092 | 6 | `s_m_Load_LEGACY_CTL_BILLING_STG_CABS` |
| 2 | BILLING_STG_ENS | 13 | 10093 | 6 | `s_m_Load_LEGACY_CTL_BILLING_STG_ENS` |
| 3 | BILLING_STG_LATIS | 13 | 10094 | 6 | `s_m_Load_LEGACY_CTL_BILLING_STG_LATIS` |

#### DG_211 — 3 members
- **Sources:** `PHYS_STRUCT, PHYS_STRUCT1`
- **Targets:** `PHYS_STRUCT_BUILDING, WFMIMP1`
- **Lookups:** `PHYS_STRUCT_BUILDING`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CALL_SERVER_1 | 29 | 11864 | 6 | `s_m_Load_FTP_GIS_CALL_SERVER_1` |
| 2 | CALL_SERVER_2 | 29 | 11865 | 6 | `s_m_Load_FTP_GIS_CALL_SERVER_2` |
| 3 | CALL_SERVER_3 | 29 | 11866 | 6 | `s_m_Load_FTP_GIS_CALL_SERVER_3` |

#### DG_212 — 3 members
- **Sources:** `CV_ORDERS_AND_TRACKING`
- **Targets:** `CIRCUIT_INVENTORY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CIRCUIT_INVENTORY_CANCELLED | 4 | 9094 | 1 | `s_m_Load_EWH_CIRCUIT_INVENTORY_CANCELLED` |
| 2 | CIRCUIT_INVENTORY_COMPLETED | 4 | 9095 | 2 | `s_m_Load_EWH_CIRCUIT_INVENTORY_COMPLETED` |
| 3 | CIRCUIT_INVENTORY_PENDING | 4 | 9096 | 1 | `s_m_Load_EWH_CIRCUIT_INVENTORY_PENDING` |

#### DG_213 — 3 members
- **Sources:** `CIRCUIT_ORDER_STG, PRODUCT_COMPNT_PRICE, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_COMPNT_PRICE`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, ORDER_PRODUCT_COMPNT, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COMPNT_PRICE_MRC | 26 | 11506 | 12 | `s_m_Load_SDP_PRODUCT_COMPNT_PRICE_MRC` |
| 2 | COMPNT_PRICE_NRC | 26 | 11507 | 12 | `s_m_Load_SDP_PRODUCT_COMPNT_PRICE_NRC` |
| 3 | PRODUCT_COMPNT_PRICE | 29 | 11967 | 11 | `s_m_Load_VLOCITY_PRODUCT_COMPNT_PRICE` |

#### DG_214 — 3 members
- **Sources:** `LEGACY_CTL_BILLING_STG, LEGACY_CTL_BILLING_STG1`
- **Targets:** `FF_LOAD_STATUS, F_TAXES_BILLED, TAXMART`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CTL_BILLING_STG | 13 | 10054 | 5 | `s_m_Load_CABS_LEGACY_CTL_BILLING_STG` |
| 2 | CTL_BILLING_STG | 13 | 10075 | 6 | `s_m_Load_ENS_LEGACY_CTL_BILLING_STG` |
| 3 | CTL_BILLING_STG | 13 | 10091 | 5 | `s_m_Load_LATIS_LEGACY_CTL_BILLING_STG` |

#### DG_215 — 3 members
- **Sources:** `AE2E_GRANITE_STG, AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG`
- **Targets:** `AE2E_ENDSTATE_GRANITE_PREP, AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG`
- **Lookups:** `AE2E_SYSTEM`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSINS_GRANITE_PREP | 2 | 7941 | 7 | `s_m_Load_AE2E_UNITY_CUSINS_GRANITE_PREP` |
| 2 | NETDIS_GRANITE_PREP | 2 | 7942 | 7 | `s_m_Load_AE2E_UNITY_NETDIS_GRANITE_PREP` |
| 3 | NETINS_GRN_PREP | 2 | 7943 | 7 | `s_m_Load_AE2E_UNITY_NETINS_GRN_PREP` |

#### DG_216 — 3 members
- **Sources:** `DUAL`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Check_Dependency_Status | 30 | 12031 | 4 | `s_m_Check_Dependency_Status` |
| 2 | Dependency_Status_ATLASMART | 30 | 12032 | 4 | `s_m_Check_Dependency_Status_ATLASMART` |
| 3 | Dependency_Status_FUSION | 30 | 12033 | 4 | `s_m_Check_Dependency_Status_FUSION` |

#### DG_217 — 3 members
- **Sources:** `FF_COUNT, FF_COUNT_NEW, FF_COUNT_OLD`
- **Targets:** `FF_COUNT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Compare_Counts | 1 | 564 | 6 | `s_m_Compare_Counts` |
| 2 | D_NETWORK_ELMNT | 1 | 565 | 6 | `s_m_Compare_Counts_D_NETWORK_ELMNT` |
| 3 | W_3SCAPE_LATAM | 1 | 566 | 6 | `s_m_Compare_Counts_W_3SCAPE_LATAM` |

#### DG_218 — 3 members
- **Sources:** `LEASED_TRAIL_DETAIL`
- **Targets:** `TGT_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Create_Target_Index | 32 | 12381 | 4 | `s_m_Create_Target_Index` |
| 2 | OFFNET_SEARCH_Index | 32 | 12383 | 4 | `s_m_Drop_OFFNET_SEARCH_Index` |
| 3 | Drop_Target_Index | 32 | 12384 | 4 | `s_m_Drop_Target_Index` |

#### DG_219 — 3 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, ACCRUAL_CHARGE_MJE_EXPORT_VOICE`
- **Targets:** `SAP_ACCRUAL_CHARGE_MJE_EXPORT_FF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DAT_EXPORT_FF | 27 | 11579 | 4 | `s_m_Load_NETEX_ALLOC_DAT_EXPORT_FF` |
| 2 | EXPORT_CDNA_FF | 27 | 11641 | 2 | `s_m_Load_VOICE_NETEX_ALLOC_EXPORT_CDNA_FF` |
| 3 | EXPORT_IVT_FF | 27 | 11642 | 2 | `s_m_Load_VOICE_NETEX_ALLOC_EXPORT_IVT_FF` |

#### DG_220 — 3 members
- **Sources:** `ASL_SYNCHRONOSS, SUPPLIER`
- **Targets:** `DUMMY_TARGET`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_COUNT_VALIDATION | 10 | 9787 | 6 | `s_m_Load_NETEX_INV_DETAIL_COUNT_VALIDATION` |
| 2 | COUNT_VALIDATION_EMEA | 10 | 9788 | 6 | `s_m_Load_NETEX_INV_DETAIL_COUNT_VALIDATION_EMEA` |
| 3 | VALIDATION_SAM_LATAM | 10 | 9789 | 6 | `s_m_Load_NETEX_INV_DETAIL_COUNT_VALIDATION_SAM_LATAM` |

#### DG_221 — 3 members
- **Sources:** `SUPPLIER_DISPUTE, SUPPLIER_DISPUTE_NOTE`
- **Targets:** `CODS_NETEX, SUPPLIER_DISPUTE_NOTE`
- **Lookups:** `SUPPLIER_DISPUTE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DISPUTES_NOTES_SAM | 21 | 10828 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTES_NOTES_SAM` |
| 2 | NOTES_SAM_EMEA | 21 | 10829 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTES_NOTES_SAM_EMEA` |
| 3 | NOTES_SAM_LATAM | 21 | 10830 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTES_NOTES_SAM_LATAM` |

#### DG_222 — 3 members
- **Sources:** `DISPUTE_DETAIL, SUPPLIER_DISPUTE_ACTIVITY`
- **Targets:** `CODS_NETEX, SUPPLIER_DISPUTE_ACTIVITY`
- **Lookups:** `SUPPLIER_DISPUTE, SUPPLIER_DISPUTE_ACTIVITY, SUPPLIER_INVOICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DISPUTE_ACTIVITY_SAM | 17 | 10506 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTE_ACTIVITY_SAM` |
| 2 | ACTIVITY_SAM_EMEA | 17 | 10507 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTE_ACTIVITY_SAM_EMEA` |
| 3 | ACTIVITY_SAM_LATAM | 17 | 10508 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTE_ACTIVITY_SAM_LATAM` |

#### DG_223 — 3 members
- **Sources:** `AE2E_BILL_TAMER_PREP, AE2E_IXPLUS_STG, AE2E_IXPLUS_STG1, AE2E_JOB_LOG, AE2E_XLINK_CV_PREP`
- **Targets:** `AE2E_IXPLUS_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DIS_IXPLUS_PREP | 42 | 12918 | 10 | `s_m_LOAD_AE2E_BW_DIS_IXPLUS_PREP` |
| 2 | HIST_IXPLUS_PREP | 42 | 12922 | 10 | `s_m_LOAD_AE2E_BW_HIST_IXPLUS_PREP` |
| 3 | INS_IXPLUS_PREP | 42 | 12924 | 10 | `s_m_LOAD_AE2E_BW_INS_IXPLUS_PREP` |

#### DG_224 — 3 members
- **Sources:** `AE2E_BILL_TAMER_PREP, AE2E_JOB_LOG, AE2E_KENAN_STG, AE2E_KENAN_STG1, AE2E_XLINK_CV_PREP +1 more`
- **Targets:** `AE2E_JOB_LOG, AE2E_KENAN_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DIS_KEN_PREP | 42 | 12919 | 15 | `s_m_LOAD_AE2E_BW_DIS_KEN_PREP` |
| 2 | IDC_KEN_PREP | 42 | 12921 | 15 | `s_m_LOAD_AE2E_BW_HIST_IDC_KEN_PREP` |
| 3 | INS_KEN_PREP | 42 | 12925 | 15 | `s_m_LOAD_AE2E_BW_INS_KEN_PREP` |

#### DG_225 — 3 members
- **Sources:** `AE2E_JOB_LOG, AE2E_KENAN_PREP, AE2E_REVAMART_STG`
- **Targets:** `AE2E_JOB_LOG, AE2E_REVAMART_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DIS_REVA_PREP | 44 | 12942 | 6 | `s_m_LOAD_AE2E_BW_DIS_REVA_PREP` |
| 2 | HIST_REVA_PREP | 44 | 12943 | 6 | `s_m_LOAD_AE2E_BW_HIST_REVA_PREP` |
| 3 | INS_REVA_PREP | 44 | 12944 | 6 | `s_m_LOAD_AE2E_BW_INS_REVA_PREP` |

#### DG_226 — 3 members
- **Sources:** `CALL_DETAIL_PROCESS`
- **Targets:** `TGT_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Dates_From_CDP | 3 | 8748 | 1 | `s_m_Get_Dates_From_CDP` |
| 2 | CALL_DETAIL_PROCESS | 3 | 8977 | 4 | `s_m_Update_From_CALL_DETAIL_PROCESS` |
| 3 | CALL_DETAIL_PROCESS | 3 | 8983 | 4 | `s_m_X_Update_From_CALL_DETAIL_PROCESS` |

#### DG_227 — 3 members
- **Sources:** `CMF, CMF_EXEMPT, CMF_EXEMPT_KENANFX, CMF_KENANFX, COUNTRY_CODE_VALUES +9 more`
- **Targets:** `F_FEDERAL_TAX_EXEMPTIONS, F_TAX_EXEMPTIONS`
- **Lookups:** `CUSTOMER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | EXEMPTIONS_FOR_IDC | 9 | 9618 | 6 | `s_m_LOAD_F_TAX_EXEMPTIONS_FOR_IDC` |
| 2 | EXEMPTIONS_FOR_KENAN | 9 | 9619 | 4 | `s_m_LOAD_F_TAX_EXEMPTIONS_FOR_KENAN` |
| 3 | TAX_EXEMPTIONS_KENAN | 9 | 9620 | 5 | `s_m_LOAD_F_TAX_EXEMPTIONS_KENAN` |

#### DG_228 — 3 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, ACCRUAL_CHARGE_MJE_EXPORT_SAP1`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP_FF, ACCRUAL_CHARGE_MJE_EXPORT_SAP_LATAM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | EXPORT_SAP_FF | 27 | 11553 | 8 | `s_m_Load_ACCRUAL_CHARGE_DETAIL_MJE_EXPORT_SAP_FF` |
| 2 | SAP_FF_CTL | 27 | 11554 | 8 | `s_m_Load_ACCRUAL_CHARGE_DETAIL_MJE_EXPORT_SAP_FF_CTL` |
| 3 | OCC_SAP_FF | 27 | 11557 | 10 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_OCC_SAP_FF` |

#### DG_229 — 3 members
- **Sources:** `BULK_GEOCODE_CUSTOMER_ADDRESS`
- **Targets:** `WEBMARS_RUNSTATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FILE_GEO_CODE | 26 | 11479 | 2 | `s_m_GENERATE_PARAMETER_FILE_GEO_CODE` |
| 2 | RUN_STATUS_INPROGRESS | 26 | 11550 | 2 | `s_m_temp_genarate_parameter_file_RUN_STATUS_INPROGRESS` |
| 3 | file_RUN_STATUS | 26 | 11551 | 2 | `s_m_temp_generate_parameter_file_RUN_STATUS` |

#### DG_230 — 3 members
- **Sources:** `F_FEDERAL_TAX_EXEMPTIONS, F_TAX_EXEMPTIONS`
- **Targets:** `FL_CONTROL_TOTAL_EXEMPTIONS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FOR_EXEMPTIONS_CDC | 10 | 9730 | 5 | `s_m_GENERATE_CONTROL_TOTALS_FOR_EXEMPTIONS_CDC` |
| 2 | FOR_EXEMPTIONS_IDC | 10 | 9731 | 5 | `s_m_GENERATE_CONTROL_TOTALS_FOR_EXEMPTIONS_IDC` |
| 3 | FOR_EXEMPTIONS_KENAN | 10 | 9732 | 5 | `s_m_GENERATE_CONTROL_TOTALS_FOR_EXEMPTIONS_KENAN` |

#### DG_231 — 3 members
- **Sources:** `BILL_INVOICE, INVOICE, INVOICE1`
- **Targets:** `CDW_COMMON, MISSING_ROW`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FOR_INVOICE_CDC | 15 | 10209 | 5 | `s_m_Load_MISSING_ROW_FOR_INVOICE_CDC` |
| 2 | INVOICE_ITEM_CDC | 15 | 10211 | 7 | `s_m_Load_MISSING_ROW_FOR_INVOICE_ITEM_CDC` |
| 3 | ITEM_TAX_CDC | 15 | 10213 | 7 | `s_m_Load_MISSING_ROW_FOR_INVOICE_ITEM_TAX_CDC` |

#### DG_232 — 3 members
- **Sources:** `DUMMY_TMP`
- **Targets:** `FF_LOAD_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FRD_AMT_CABS | 1 | 2915 | 3 | `s_m_Load_FRD_AMT_CABS` |
| 2 | AMT_INS_UPD | 1 | 2916 | 3 | `s_m_Load_FRD_AMT_INS_UPD` |
| 3 | INS_UPD_NIBS | 1 | 2917 | 3 | `s_m_Load_FRD_AMT_INS_UPD_NIBS` |

#### DG_233 — 3 members
- **Sources:** `DUMMY_NBR_SRC, TMP_FRD_AMT_ARTLDA, TMP_FRD_AMT_JLA`
- **Targets:** `FF_DUMMY, FF_LOAD_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FRD_AMT_DRBJL | 1 | 6108 | 6 | `s_m_Load_TMP_FRD_AMT_DRBJL` |
| 2 | FRD_AMT_JLA | 1 | 6110 | 7 | `s_m_Load_TMP_FRD_AMT_JLA` |
| 3 | AMT_JLA_SAP | 1 | 6111 | 6 | `s_m_Load_TMP_FRD_AMT_JLA_SAP` |

#### DG_234 — 3 members
- **Sources:** `ACCRUAL_CHARGE, ACCRUAL_CHARGE1, ACCRUAL_INSTANCE, ACCRUAL_INSTANCE1`
- **Targets:** `ACCRUAL_CHARGE, DSL_AIM`
- **Lookups:** `GL_ACCOUNT_DESC`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GL_ACCRUAL_CHARGE | 22 | 11080 | 7 | `s_m_Update_GL_ACCRUAL_CHARGE` |
| 2 | CHARGE_EMEA_DIVESTITURE | 22 | 11081 | 7 | `s_m_Update_GL_ACCRUAL_CHARGE_EMEA_DIVESTITURE` |
| 3 | CHARGE_LATAM_DIVESTITURE | 22 | 11082 | 7 | `s_m_Update_GL_ACCRUAL_CHARGE_LATAM_DIVESTITURE` |

#### DG_235 — 3 members
- **Sources:** `USOC_BILLED`
- **Targets:** `CODS_NETEX, USOC_BILLED`
- **Lookups:** `USOC_GL_ACCOUNT_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GL_ACT_CD | 2 | 8467 | 5 | `s_m_Upd_NETEX_USOC_BILLED_GL_ACT_CD` |
| 2 | ACT_CD_CTL | 2 | 8468 | 5 | `s_m_Upd_NETEX_USOC_BILLED_GL_ACT_CD_CTL` |
| 3 | CD_SAM_LATAM | 2 | 8471 | 5 | `s_m_Upd_NETEX_USOC_BILLED_GL_ACT_CD_SAM_LATAM` |

#### DG_236 — 3 members
- **Sources:** `ASL_SYNCHRONOSS, SUPPLIER, SUPPLIER_CIRCUIT`
- **Targets:** `CODS_NETEX, DUMMY_TARGET, SUPPLIER_CIRCUIT`
- **Lookups:** `SUPPLIER_BILLING_ACCOUNT, SUPPLIER_CIRCUIT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ILEC_COLO_SAM | 16 | 10370 | 16 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ILEC_COLO_SAM` |
| 2 | COLO_SAM_EMEA | 16 | 10371 | 16 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ILEC_COLO_SAM_EMEA` |
| 3 | COLO_SAM_LATAM | 16 | 10372 | 16 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ILEC_COLO_SAM_LATAM` |

#### DG_237 — 3 members
- **Sources:** `ADJ, ADJ_REASON_CODE_VALUES, BILLING_PRODUCT_COMPNT, BILL_INVOICE, INVOICE_ADJ_REQUEST +3 more`
- **Targets:** `FF_LOAD_STATUS, INVOICE_ADJ_REQUEST, STG_INVOICE_ADJ_REQUEST`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, SOURCE_BILLING_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INVOICE_ADJ_REQUEST | 15 | 10195 | 12 | `s_m_Load_INVOICE_ADJ_REQUEST` |
| 2 | ADJ_REQUEST_KENANFX | 15 | 10196 | 12 | `s_m_Load_INVOICE_ADJ_REQUEST_KENANFX` |
| 3 | KENANFX_HISTORY_LOAD | 15 | 10197 | 12 | `s_m_Load_INVOICE_ADJ_REQUEST_KENANFX_HISTORY_LOAD` |

#### DG_238 — 3 members
- **Sources:** `SUPP_INV_AUDIT_PROVIDER, SUPP_INV_AUDIT_PROVIDER1`
- **Targets:** `CODS_NETEX, SUPP_INV_AUDIT_PROVIDER`
- **Lookups:** `SUPPLIER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_AUDIT_PROVIDER | 10 | 9793 | 11 | `s_m_Load_NETEX_SUPP_INV_AUDIT_PROVIDER` |
| 2 | AUDIT_PROVIDER_CTL | 10 | 9794 | 11 | `s_m_Load_NETEX_SUPP_INV_AUDIT_PROVIDER_CTL` |
| 3 | PROVIDER_SAM_LATAM | 10 | 9797 | 11 | `s_m_Load_NETEX_SUPP_INV_AUDIT_PROVIDER_SAM_LATAM` |

#### DG_239 — 3 members
- **Sources:** `SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL_TMP`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL, USOC_BILLED`
- **Lookups:** `SUPPLIER_INV_DETAIL_TMP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_DETAIL_Phase3 | 23 | 11179 | 9 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase3` |
| 2 | DETAIL_Phase3_CTL | 23 | 11180 | 9 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase3_CTL` |
| 3 | DETAIL_Phase3_SAM | 23 | 11181 | 9 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase3_SAM` |

#### DG_240 — 3 members
- **Sources:** `SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL1`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL, USOC_BILLED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_DETAIL_Phase4 | 1 | 6876 | 4 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase4` |
| 2 | DETAIL_Phase4_CTL | 1 | 6877 | 5 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase4_CTL` |
| 3 | DETAIL_Phase4_SAM | 1 | 6878 | 5 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase4_SAM` |

#### DG_241 — 3 members
- **Sources:** `ADJ_REASON_CODE_VALUES, BILLING_PRODUCT_COMPNT, BILL_INVOICE, BILL_INVOICE_DETAIL, COMPONENT_DEFINITION_VALUES +5 more`
- **Targets:** `INVOICE_ITEM`
- **Lookups:** `ADJ, CURRENCY_EXCHANGE_RATE, DESCRIPTIONS, INVOICE, INVOICE_ITEM +2 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ITEM_IDC_KENAN | 15 | 10198 | 20 | `s_m_Load_INVOICE_ITEM_IDC_KENAN` |
| 2 | INVOICE_ODS_IDS | 15 | 10200 | 23 | `s_m_Load_INVOICE_ITEM_IDC_KENAN_MISSING_INVOICE_ODS_IDS` |
| 3 | MISSING_NOVEMBER_INVOICES | 15 | 10201 | 22 | `s_m_Load_INVOICE_ITEM_IDC_KENAN_MISSING_NOVEMBER_INVOICES` |

#### DG_242 — 3 members
- **Sources:** `INVOICE_ITEM_TAX, STG_INVOICE_ITEM_TAX, STG_INVOICE_ITEM_TAX1`
- **Targets:** `INVOICE_ITEM_TAX`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ITEM_TAX_IDC | 1 | 3139 | 9 | `s_m_Load_INVOICE_ITEM_TAX_IDC` |
| 2 | TAX_IDC_fix1 | 12 | 9994 | 9 | `s_m_Load_INVOICE_ITEM_TAX_IDC_fix1` |
| 3 | ITEM_TAX_KENANFX | 12 | 9995 | 9 | `s_m_Load_INVOICE_ITEM_TAX_KENANFX` |

#### DG_243 — 3 members
- **Sources:** `DUMMY_SRC`
- **Targets:** `FF_START_DT, M_JOB_CONTROL_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | JOB_CONTROL_STATUS | 1 | 659 | 2 | `s_m_Insert_M_JOB_CONTROL_STATUS` |
| 2 | CONTROL_STATUS_hh24 | 1 | 660 | 2 | `s_m_Insert_M_JOB_CONTROL_STATUS_hh24` |
| 3 | CONTROL_STATUS_hh24miss | 1 | 661 | 2 | `s_m_Insert_M_JOB_CONTROL_STATUS_hh24miss` |

#### DG_244 — 3 members
- **Sources:** `FF_START_DT`
- **Targets:** `M_JOB_CONTROL_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | JOB_CONTROL_STATUS | 2 | 8504 | 3 | `s_m_Update_M_JOB_CONTROL_STATUS` |
| 2 | CONTROL_STATUS_hh24 | 2 | 8505 | 3 | `s_m_Update_M_JOB_CONTROL_STATUS_hh24` |
| 3 | CONTROL_STATUS_hh24miss | 2 | 8506 | 3 | `s_m_Update_M_JOB_CONTROL_STATUS_hh24miss` |

#### DG_245 — 3 members
- **Sources:** `SERVICE, SERVICE_RELATIONSHIP`
- **Targets:** `CODS_SERVICE, SERVICE_RELATIONSHIP`
- **Lookups:** `SERVICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LIMS_SERVICE_RELATIONSHIP | 25 | 11390 | 10 | `s_m_Load_LIMS_SERVICE_RELATIONSHIP` |
| 2 | SERVICENOW_SERVICE_RELATIONSHIP | 25 | 11392 | 8 | `s_m_Load_LUMEN_SERVICENOW_SERVICE_RELATIONSHIP` |
| 3 | PRO_SERVICE_RELATIONSHIP | 25 | 11412 | 10 | `s_m_Load_PRO_SERVICE_RELATIONSHIP` |

#### DG_246 — 3 members
- **Sources:** `CONTACT, CONTACT1, CONTACT11, SOURCE_CONTACT, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, CODS_STG, CONTACT, DUMMY_TGT, SOURCE_CONTACT +1 more`
- **Lookups:** `SOURCE_CONTACT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LOAD_CONTACT | 4 | 9055 | 26 | `s_m_LOAD_CONTACT` |
| 2 | Load_CLARIFY_CONTACT | 4 | 9076 | 26 | `s_m_Load_CLARIFY_CONTACT` |
| 3 | Load_RSOR_CONTACT | 4 | 9136 | 26 | `s_m_Load_RSOR_CONTACT` |

#### DG_247 — 3 members
- **Sources:** `TN_INVENTORY, TN_LOOKUP, TN_LOOKUP_DEL1, TN_LOOKUP_DEL_CPO, TN_LOOKUP_DEL_FF +3 more`
- **Targets:** `DB_LINK_OUT, TN_LOOKUP, TN_LOOKUP_DELTA_MERGE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LOOKUP_DELTA_MERGE | 31 | 12271 | 11 | `s_m_LOAD_TN_LOOKUP_DELTA_MERGE` |
| 2 | DELTA_MERGE_CPO | 31 | 12272 | 11 | `s_m_LOAD_TN_LOOKUP_DELTA_MERGE_CPO` |
| 3 | DELTA_MERGE_PIPELINE | 31 | 12273 | 11 | `s_m_LOAD_TN_LOOKUP_DELTA_MERGE_PIPELINE` |

#### DG_248 — 3 members
- **Sources:** `NETWORKELEMENT, NETWORKELEMENT1`
- **Targets:** `CRPL_NETFLEX, NETWORKELEMENT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_NETWORKELEMENT | 1 | 3606 | 2 | `s_m_Load_NETWORKELEMENT` |
| 2 | NETWORKELEMENT_EMEA_ODC | 1 | 3608 | 2 | `s_m_Load_NETWORKELEMENT_EMEA_ODC` |
| 3 | Load_NETWORKELEMENT_SRVR2 | 1 | 3610 | 2 | `s_m_Load_NETWORKELEMENT_SRVR2` |

#### DG_249 — 3 members
- **Sources:** `EQUIPMENT, RACK`
- **Targets:** `CODS_NETINV, RACK`
- **Lookups:** `PHYS_STRUCT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_RACK_LIMS | 27 | 11589 | 10 | `s_m_Load_RACK_LIMS` |
| 2 | Load_RACK_TIRKS | 27 | 11591 | 10 | `s_m_Load_RACK_TIRKS` |
| 3 | load_RACK_ARM | 29 | 11990 | 9 | `s_m_load_RACK_ARM` |

#### DG_250 — 3 members
- **Sources:** `EQUIPMENT_HOLDER, SLOT`
- **Targets:** `CODS_NETINV, SLOT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_SLOT_ARM | 9 | 9716 | 10 | `s_m_Load_SLOT_ARM` |
| 2 | Load_SLOT_LIMS | 9 | 9719 | 10 | `s_m_Load_SLOT_LIMS` |
| 3 | Load_SLOT_TIRKS | 9 | 9720 | 10 | `s_m_Load_SLOT_TIRKS` |

#### DG_251 — 3 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT`
- **Targets:** `NETEX_ALLOCATION_FF_TEMPLATE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MJE_EXPORT_FF | 25 | 11384 | 3 | `s_m_Load_GC_USF_MJE_EXPORT_FF` |
| 2 | MJE_EXPORT_FF | 25 | 11440 | 3 | `s_m_Load_Tails_MJE_EXPORT_FF` |
| 3 | MJE_EXPORT_FF | 25 | 11446 | 3 | `s_m_Load_VYVX_MJE_EXPORT_FF` |

#### DG_252 — 3 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT, ACCRUAL_CHARGE_MJE_EXPORT_DR_AMT, DSL_AIM`
- **Lookups:** `ACCRUAL_CHARGE_MJE_EXPORT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MJE_Step2_Adjustments | 1 | 6254 | 3 | `s_m_Load_Tails_MJE_Step2_Adjustments` |
| 2 | USF_MJE_ADJUSTMENTS | 1 | 6294 | 3 | `s_m_Load_USF_MJE_ADJUSTMENTS` |
| 3 | VYVX_MJE_ADJUSTMENTS | 1 | 6406 | 3 | `s_m_Load_VYVX_MJE_ADJUSTMENTS` |

#### DG_253 — 3 members
- **Sources:** `SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL2, USOC_BILLED, USOC_BILLED2`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL, USOC_BILLED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MRII_Update_SAM | 1 | 6866 | 10 | `s_m_Upd_Load_NETEX_MRII_Update_SAM` |
| 2 | Update_SAM_EMEA | 1 | 6867 | 10 | `s_m_Upd_Load_NETEX_MRII_Update_SAM_EMEA` |
| 3 | Update_SAM_LATAM | 1 | 6868 | 10 | `s_m_Upd_Load_NETEX_MRII_Update_SAM_LATAM` |

#### DG_254 — 3 members
- **Sources:** `SUPPLIER, SUPPLIER1, VENDOR`
- **Targets:** `DUMMY_TARGET, SUPPLIER`
- **Lookups:** `ULTIMATE_SUPPLIER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETEX_SUPPLIER_SAM | 2 | 8152 | 19 | `s_m_Load_NETEX_SUPPLIER_SAM` |
| 2 | SUPPLIER_SAM_EMEA | 2 | 8153 | 19 | `s_m_Load_NETEX_SUPPLIER_SAM_EMEA` |
| 3 | SUPPLIER_SAM_LATAM | 2 | 8154 | 19 | `s_m_Load_NETEX_SUPPLIER_SAM_LATAM` |

#### DG_255 — 3 members
- **Sources:** `PHYS_STRUCT_GEOCODE, PHYS_STRUCT_GEOCODE2`
- **Targets:** `CODS_NETINV_STG, PHYS_STRUCT_GEOCODE`
- **Lookups:** `PHYS_STRUCT, PHYS_STRUCT_GEOCODE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NULL_XREF_GLM | 29 | 12020 | 16 | `s_m_update_PHYS_STRUCT_GECODE_NULL_XREF_GLM` |
| 2 | N_XREF_GLM | 29 | 12021 | 16 | `s_m_update_PHYS_STRUCT_GECODE_N_XREF_GLM` |
| 3 | GECODE_XREF_GLM | 29 | 12022 | 16 | `s_m_update_PHYS_STRUCT_GECODE_XREF_GLM` |

#### DG_256 — 3 members
- **Sources:** `DUMMY_ENS_SRC`
- **Targets:** `DUMMY_PART_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_ATTRIB_REV | 1 | 6745 | 1 | `s_m_Partitions_Exchange_CUST_ORDER_ATTRIB_REV` |
| 2 | CUSTOMER_ORDER_PRODUCT | 1 | 6746 | 1 | `s_m_Partitions_Exchange_V_CUSTOMER_ORDER_PRODUCT` |
| 3 | ORDER_PRODUCT_COMPNT | 1 | 6747 | 1 | `s_m_Partitions_Exchange_V_ORDER_PRODUCT_COMPNT` |

#### DG_257 — 3 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, CUSTOMER_ORDER_PRODUCT1, ORDER_PRODUCT_COMPNT`
- **Targets:** `CUST_ORDER_ATTRIB_REV, DSL_ORDER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_ATTRIB_REV | 17 | 10464 | 19 | `s_m_Load_CUST_ORDER_ATTRIB_REV` |
| 2 | ORDER_ATTRIB_REV1 | 17 | 10465 | 19 | `s_m_Load_CUST_ORDER_ATTRIB_REV1` |
| 3 | ATTRIB_REV_COP | 17 | 10466 | 19 | `s_m_Load_CUST_ORDER_ATTRIB_REV_COP` |

#### DG_258 — 3 members
- **Sources:** `CIRCUIT_ORDER_STG, ORDER_PRODUCT_ENDPNT, ORDER_PRODUCT_ENDPNT1`
- **Targets:** `CODS, ORDER_PRODUCT_ENDPNT`
- **Lookups:** `CUSTOMER_ORDER_PRODUCT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_ENDPNT | 18 | 10553 | 9 | `s_m_Load_EIS_ORDER_PRODUCT_ENDPNT` |
| 2 | ORDER_PRODUCT_ENDPNT | 18 | 10557 | 9 | `s_m_Load_ENS_MM_ORDER_PRODUCT_ENDPNT` |
| 3 | ORDER_PRODUCT_ENDPNT | 27 | 11585 | 9 | `s_m_Load_QF_ORDER_PRODUCT_ENDPNT` |

#### DG_259 — 3 members
- **Sources:** `F_PROV_ORDER_ALL_MEASURES`
- **Targets:** `DUMMY_SP_REFRESH_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_STATUS_MV | 34 | 12635 | 4 | `s_m_Refresh_V_PORTAL_ORDER_STATUS_MV` |
| 2 | ALL_MEASURES_MV | 34 | 12636 | 4 | `s_m_Refresh_V_PROV_ORDER_ALL_MEASURES_MV` |
| 3 | ORDER_ALL_MV | 34 | 12637 | 4 | `s_m_Refresh_V_PROV_ORDER_ALL_MV` |

#### DG_260 — 3 members
- **Sources:** `PRODUCT_DEFINITION, PRODUCT_SPECIFICATION`
- **Targets:** `CODS, PRODUCT_SPECIFICATION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PCAT_PRODUCT_SPECIFICATION | 2 | 8212 | 8 | `s_m_Load_PCAT_PRODUCT_SPECIFICATION` |
| 2 | SDWF_PRODUCT_SPECIFICATION | 2 | 8338 | 10 | `s_m_Load_SDWF_PRODUCT_SPECIFICATION` |
| 3 | SWIFT_PRODUCT_SPECIFICATION | 2 | 8374 | 10 | `s_m_Load_SWIFT_PRODUCT_SPECIFICATION` |

#### DG_261 — 3 members
- **Sources:** `BILLING_FREQUENCY_VALUES, BILLING_PERIOD, BILL_CYCLE`
- **Targets:** `BILLING_PERIOD, CODS_BILLING`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PERIOD_IDC_KENAN | 2 | 7975 | 10 | `s_m_Load_BILLING_PERIOD_IDC_KENAN` |
| 2 | BILLING_PERIOD_KENANFX | 2 | 7976 | 10 | `s_m_Load_BILLING_PERIOD_KENANFX` |
| 3 | PERIOD_KENAN_LATAM | 2 | 7977 | 10 | `s_m_Load_BILLING_PERIOD_KENAN_LATAM` |

#### DG_262 — 3 members
- **Sources:** `UP_PROCSTAT_UPD`
- **Targets:** `BUSINESS_REJECT_SUMMARY, PROCESSING_STAT, UP_SOURCE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PROCESSING_STAT_KENANIDC | 1 | 7019 | 6 | `s_m_Update_PROCESSING_STAT_KENANIDC` |
| 2 | PROCESSING_STAT_POSTCORR | 1 | 7020 | 6 | `s_m_Update_PROCESSING_STAT_POSTCORR` |
| 3 | PROCESSING_STAT_UP | 1 | 7021 | 6 | `s_m_Update_PROCESSING_STAT_UP` |

#### DG_263 — 3 members
- **Sources:** `PO_PRODUCT_INSTANCE, PO_SERVICE_ADDRESS, PRODUCT_COMPNT_ENDPNT, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_COMPNT_ENDPNT`
- **Lookups:** `ORDER_PRODUCT_COMPNT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_COMPNT_ENDPNT | 15 | 10172 | 11 | `s_m_Load_CPO_PRODUCT_COMPNT_ENDPNT` |
| 2 | PRODUCT_COMPNT_ENDPNT | 22 | 10996 | 11 | `s_m_Load_LUMEN_SERVICENOW_PRODUCT_COMPNT_ENDPNT` |
| 3 | PRODUCT_COMPNT_ENDPNT | 29 | 11930 | 12 | `s_m_Load_SWIFT_PRODUCT_COMPNT_ENDPNT` |

#### DG_264 — 3 members
- **Sources:** `CIRCUIT_ORDER_STG, CUSTOMER_ORDER_PRODUCT, PRODUCT_COMPNT_PRICE`
- **Targets:** `CODS, PRODUCT_COMPNT_PRICE`
- **Lookups:** `PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_COMPNT_PRICE | 12 | 9958 | 9 | `s_m_Load_BM_PRODUCT_COMPNT_PRICE` |
| 2 | PRODUCT_COMPNT_PRICE | 18 | 10560 | 9 | `s_m_Load_ENS_MM_PRODUCT_COMPNT_PRICE` |
| 3 | PRODUCT_COMPNT_PRICE | 22 | 11052 | 9 | `s_m_Load_QF_PRODUCT_COMPNT_PRICE` |

#### DG_265 — 3 members
- **Sources:** `PRODUCT_ELEMENT_COST, QO_COMPONENTINSTANCE`
- **Targets:** `PRODUCT_ELEMENT_COST`
- **Lookups:** `ORDER_PRODUCT_ELEMENT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_ELEMENT_COST | 30 | 12147 | 10 | `s_m_Load_PIPELINE_PRODUCT_ELEMENT_COST` |
| 2 | PRODUCT_ELEMENT_COST | 30 | 12154 | 10 | `s_m_Load_SDP_PRODUCT_ELEMENT_COST` |
| 3 | PRODUCT_ELEMENT_COST | 30 | 12174 | 10 | `s_m_Load_SWIFT_PRODUCT_ELEMENT_COST` |

#### DG_266 — 3 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, CUSTOMER_ORDER_PRODUCT1, ROLLBACK_ACCOUNTS`
- **Targets:** `CUSTOMER_ORDER_PRODUCT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_Rollback_DEL | 1 | 1213 | 9 | `s_m_Load_BM_CUSTOMER_ORDER_PRODUCT_Rollback_DEL` |
| 2 | Rollback_DEL_OrderLevel | 1 | 1214 | 7 | `s_m_Load_BM_CUSTOMER_ORDER_PRODUCT_Rollback_DEL_OrderLevel` |
| 3 | Rollback_DEL_SiteLevel | 1 | 1215 | 7 | `s_m_Load_BM_CUSTOMER_ORDER_PRODUCT_Rollback_DEL_SiteLevel` |

#### DG_267 — 3 members
- **Sources:** `ASSET_PROD_COMPNT_ENDPNT, CIRCUIT_ASSET_STG`
- **Targets:** `ASSET_PROD_COMPNT_ENDPNT, CODS`
- **Lookups:** `ASSET_PRODUCT_COMPNT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PROD_COMPNT_ENDPNT | 30 | 12108 | 10 | `s_m_Load_CPO_ASSET_PROD_COMPNT_ENDPNT` |
| 2 | PROD_COMPNT_ENDPNT | 30 | 12131 | 10 | `s_m_Load_LUMEN_SERVICENOW_ASSET_PROD_COMPNT_ENDPNT` |
| 3 | PROD_COMPNT_ENDPNT | 30 | 12170 | 10 | `s_m_Load_SWIFT_ASSET_PROD_COMPNT_ENDPNT` |

#### DG_268 — 3 members
- **Sources:** `ASSET_PROD_COMPNT_PRICE, ASSET_PROD_COMPNT_PRICE1, CIRCUIT_ASSET_STG`
- **Targets:** `ASSET_PROD_COMPNT_PRICE, CODS`
- **Lookups:** `ASSET_PRODUCT_COMPNT, CURRENCY_EXCHANGE_RATE, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PROD_COMPNT_PRICE | 30 | 12148 | 10 | `s_m_Load_PROD_ASSET_PROD_COMPNT_PRICE` |
| 2 | PROD_COMPNT_PRICE | 30 | 12171 | 10 | `s_m_Load_SWIFT_ASSET_PROD_COMPNT_PRICE` |
| 3 | PROD_COMPNT_PRICE | 30 | 12190 | 10 | `s_m_Load_VLOCITY_ASSET_PROD_COMPNT_PRICE` |

#### DG_269 — 3 members
- **Sources:** `QUOTEPRODUCTCOMPONENT`
- **Targets:** `FF_LOAD_STATUS, ISOURCE, QUOTEPRODUCTCOMPONENT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | QUOTEPRODUCTCOMPONENT_Initial_Load | 1 | 4584 | 4 | `s_m_Load_QUOTEPRODUCTCOMPONENT_Initial_Load` |
| 2 | Initial_Load_p1 | 1 | 4585 | 4 | `s_m_Load_QUOTEPRODUCTCOMPONENT_Initial_Load_p1` |
| 3 | Initial_Load_p2 | 1 | 4586 | 4 | `s_m_Load_QUOTEPRODUCTCOMPONENT_Initial_Load_p2` |

#### DG_270 — 3 members
- **Sources:** `OOR_TP_RESP, OOR_TP_RESP21, ORDERXMLDATA`
- **Targets:** `OOR_TP_RESP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RESP_ERROR_CLARIFICATION | 1 | 7509 | 19 | `s_m_load_OOR_TP_RESP_ERROR_CLARIFICATION` |
| 2 | RESP_JEOPARDY_NOTIFY | 1 | 7510 | 21 | `s_m_load_OOR_TP_RESP_JEOPARDY_NOTIFY` |
| 3 | NOTIFY_ONETIME_INS | 1 | 7511 | 20 | `s_m_load_OOR_TP_RESP_JEOP_NOTIFY_ONETIME_INS` |

#### DG_271 — 3 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_MNTH, BILLED_REVENUE_TAX_VW_MNTH`
- **Targets:** `F_RVN_CTGRY_ALLCTN_PRCNT_MNTH, TAXMART`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_MNTH_166 | 1 | 64 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_166` |
| 2 | REVENUE_MNTH_169 | 1 | 65 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_169` |
| 3 | REVENUE_MNTH_175 | 1 | 66 | 4 | `s_m_CALC_ALLOCATION_PERCENTAGE_USING_BILLED_REVENUE_MNTH_175` |

#### DG_272 — 3 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_MNTH, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2, F_RVN_CTGRY_ALLCTN_PRCNT_MNTH +8 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_MNTH`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_MNTH_169 | 25 | 11321 | 49 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_169` |
| 2 | REVENUE_MNTH_175 | 25 | 11322 | 49 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_175` |
| 3 | REVENUE_MNTH_624 | 25 | 11326 | 49 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_624` |

#### DG_273 — 3 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_QRTR, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2, F_RVN_CTGRY_ALLCTN_PRCNT_QRTR +2 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_QRTR`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_QRTR_007 | 25 | 11330 | 25 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_007` |
| 2 | REVENUE_QRTR_133 | 25 | 11334 | 25 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_133` |
| 3 | REVENUE_QRTR_624 | 25 | 11341 | 25 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_624` |

#### DG_274 — 3 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_YR, BILLED_REVENUE_RGLTRY_VW_YR1, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2 +3 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_YR`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_206 | 25 | 11354 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_206` |
| 2 | REVENUE_YR_242 | 25 | 11355 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_242` |
| 3 | REVENUE_YR_CBP | 25 | 11359 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_CBP` |

#### DG_275 — 3 members
- **Sources:** `BILL_INVOICE, INVOICE, INVOICE1`
- **Targets:** `MISSING_ROW`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ROW_FOR_INVOICE | 15 | 10208 | 5 | `s_m_Load_MISSING_ROW_FOR_INVOICE` |
| 2 | FOR_INVOICE_ITEM | 15 | 10210 | 7 | `s_m_Load_MISSING_ROW_FOR_INVOICE_ITEM` |
| 3 | INVOICE_ITEM_TAX | 15 | 10212 | 7 | `s_m_Load_MISSING_ROW_FOR_INVOICE_ITEM_TAX` |

#### DG_276 — 3 members
- **Sources:** `DUAL_STRING`
- **Targets:** `TGT_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Relational_Connection_MySQL | 1 | 6829 | 1 | `s_m_Test_Relational_Connection_MySQL` |
| 2 | Relational_Connection_Oracle | 1 | 6832 | 1 | `s_m_Test_Relational_Connection_Oracle` |
| 3 | Relational_Connection_Sybase | 1 | 6834 | 1 | `s_m_Test_Relational_Connection_Sybase` |

#### DG_277 — 3 members
- **Sources:** `SOURCE_CONTACT_ROLE`
- **Targets:** `CODS, SOURCE_CONTACT_ROLE`
- **Lookups:** `CUSTOMER_ORDER, CUSTOMER_ORDER_PRODUCT, LKP_CUSTOMER_ORDER, SOURCE_CONTACT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SOURCE_CONTACT_ROLE | 13 | 10060 | 9 | `s_m_Load_CORE_SOURCE_CONTACT_ROLE` |
| 2 | SOURCE_CONTACT_ROLE | 18 | 10561 | 9 | `s_m_Load_ENS_MM_SOURCE_CONTACT_ROLE` |
| 3 | SOURCE_CONTACT_ROLE | 21 | 10816 | 9 | `s_m_Load_LIMS_SOURCE_CONTACT_ROLE` |

#### DG_278 — 3 members
- **Sources:** `F_GAAP_REVENUE`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SOURCE_TMP_GAAP | 25 | 11362 | 2 | `s_m_CALL_PROC_CREATE_SOURCE_TMP_GAAP` |
| 2 | GAAP_REVENUE_TAXMART | 25 | 11363 | 2 | `s_m_EXCHG_F_GAAP_REVENUE_TAXMART` |
| 3 | TGT_TMP_GAAP | 25 | 11448 | 2 | `s_m_TRUNC_TGT_TMP_GAAP` |

#### DG_279 — 3 members
- **Sources:** `PHYS_STRUCT_GEOCODE`
- **Targets:** `CODS_NETINV_STG, PHYS_STRUCT_GEOCODE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STRUCT_GLM_API | 1 | 4126 | 6 | `s_m_Load_PHYS_STRUCT_GLM_API` |
| 2 | STATUS_TO_NULL | 1 | 7755 | 3 | `s_m_update_PHYS_STRUCT_INTL_CLEANSED_STATUS_TO_NULL` |
| 3 | flag_to_N | 1 | 7761 | 3 | `s_m_update_geocode_flag_to_N` |

#### DG_280 — 3 members
- **Sources:** `STG_SERVICE_VIEW`
- **Targets:** `CODS_BILLING_STG, STG_SERVICE_VIEW`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SUB_KENANFX_HISTORY | 1 | 5318 | 2 | `s_m_Load_STG_SERVICE_VIEW_BPC_MISSING_AND_STATE_NULL_SUB_KENANFX_HISTORY` |
| 2 | SERVICE_VIEW_KENANFX | 1 | 5319 | 2 | `s_m_Load_STG_SERVICE_VIEW_KENANFX` |
| 3 | VIEW_KENANFX_HISTLOAD | 1 | 5320 | 2 | `s_m_Load_STG_SERVICE_VIEW_KENANFX_HISTLOAD` |

#### DG_281 — 3 members
- **Sources:** `D_CUSTOMER, D_CUSTOMER1, D_SWITCH, D_SWITCH1, D_TRUNKGROUP +7 more`
- **Targets:** `FF_TG_TRAFFIC_REPORT`
- **Lookups:** `CRETG, D_TRUNKGROUP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Traffic_Report_ENASS | 23 | 11088 | 18 | `s_m_Create_1Day_TG_Traffic_Report_ENASS` |
| 2 | Traffic_Report_ENASS | 23 | 11089 | 18 | `s_m_Create_1Hour_TG_Traffic_Report_ENASS` |
| 3 | Traffic_Report_ENASS | 23 | 11090 | 13 | `s_m_Create_5Min_TG_Traffic_Report_ENASS` |

#### DG_282 — 3 members
- **Sources:** `ACCRUAL_CHARGE`
- **Targets:** `ACCRUAL_INSTANCE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Truncate_ACCRUAL_INSTANCE | 21 | 10931 | 1 | `s_m_Truncate_ACCRUAL_INSTANCE` |
| 2 | INSTANCE_EMEA_DIVESTITURE | 21 | 10932 | 1 | `s_m_Truncate_ACCRUAL_INSTANCE_EMEA_DIVESTITURE` |
| 3 | INSTANCE_LATAM_DIVESTITURE | 21 | 10933 | 1 | `s_m_Truncate_ACCRUAL_INSTANCE_LATAM_DIVESTITURE` |

#### DG_283 — 3 members
- **Sources:** `CAVSMT00, CAVSMT001`
- **Targets:** `FF_MMS_FACT, X_MMS_PROCESS_CONTROL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Unload_Scenario_A | 1 | 6715 | 4 | `s_m_MMS_Fact_Unload_Scenario_A` |
| 2 | Unload_Scenario_B | 1 | 6716 | 4 | `s_m_MMS_Fact_Unload_Scenario_B` |
| 3 | Unload_Scenario_C | 1 | 6717 | 4 | `s_m_MMS_Fact_Unload_Scenario_C` |

#### DG_284 — 3 members
- **Sources:** `ADMINDOMAIN_SUBTYPES`
- **Targets:** `ADMIN_ADMIN_DOMAIN_SUBTYPE`
- **Lookups:** `ADMIN_DOMAIN_SUBTYPE, CI_DOMAIN`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | admin_domain_subtype | 2 | 8528 | 9 | `s_m_admin_admin_domain_subtype` |
| 2 | item_rearng_spec | 27 | 11687 | 9 | `s_m_order_item_rearng_spec` |
| 3 | rack_tp_delete | 27 | 11693 | 9 | `s_m_rack_tp_delete` |

#### DG_285 — 3 members
- **Sources:** `DUMMY_STATS, DUMMY_STATS2`
- **Targets:** `DUMMY_STATS1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | dummy | 1 | 10 | 2 | `s_dummy` |
| 2 | gather_stats | 1 | 7225 | 2 | `s_m_gather_stats` |
| 3 | gather_stats_cop | 1 | 7226 | 2 | `s_m_gather_stats_cop` |

#### DG_286 — 3 members
- **Sources:** `F_TAXES_BILLED, LEGACY_CTL_BILLING_STG, LEGACY_STG_FTB_RECON_WORK, LEGACY_STG_FTB_RECON_WORK1, LEGACY_STG_TAXES_BILLED_RECON +1 more`
- **Targets:** `FF_LEGACY_STG_TAXES_BILLED_RECON, LEGACY_STG_FTB_RECON_WORK, LEGACY_STG_TAXES_BILLED_RECON, TAXMART`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | taxes_billed_cabs | 29 | 12004 | 10 | `s_m_recon_legacy_ctl_billing_stg_f_taxes_billed_cabs` |
| 2 | taxes_billed_ens | 29 | 12005 | 10 | `s_m_recon_legacy_ctl_billing_stg_f_taxes_billed_ens` |
| 3 | taxes_billed_latis | 29 | 12006 | 10 | `s_m_recon_legacy_ctl_billing_stg_f_taxes_billed_latis` |

#### DG_287 — 3 members
- **Sources:** `DSS_CIRCUIT`
- **Targets:** `DSS_CIRCUIT, DSS_CIRCUIT_ENDPOINT_DESIGN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | tsp_child_ind | 1 | 7762 | 4 | `s_m_update_tsp_child_ind` |
| 2 | child_ind_recursive | 1 | 7763 | 4 | `s_m_update_tsp_child_ind_recursive` |
| 3 | child_ind_recursive1 | 1 | 7764 | 4 | `s_m_update_tsp_child_ind_recursive1` |

#### DG_288 — 2 members
- **Sources:** `M_VSUM_PROCESS_CONTROL`
- **Targets:** `FF_MVPC_LINE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | 4_Daily_MVPC | 2 | 7776 | 3 | `s_m_4_Daily_MVPC` |
| 2 | 4_Daily_MVPC2 | 2 | 7777 | 3 | `s_m_4_Daily_MVPC2` |

#### DG_289 — 2 members
- **Sources:** `CIRCUIT_DETAIL, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL1`
- **Targets:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_CIRCUIT, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ACCT_MRC_SAM | 19 | 10649 | 12 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ACCT_MRC_SAM` |
| 2 | ASG_MRC_SAM | 19 | 10650 | 12 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ASG_MRC_SAM` |

#### DG_290 — 2 members
- **Sources:** `SUPPLIER_BILL_ACCT_NOTE, SUPPLIER_INVOICE`
- **Targets:** `CODS_NETEX, SUPPLIER_BILL_ACCT_NOTE`
- **Lookups:** `SUPPLIER_BILLING_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ACCT_NOTE_SAM | 20 | 10690 | 10 | `s_m_Load_NETEX_SUPPLIER_BILL_ACCT_NOTE_SAM` |
| 2 | NOTE_SAM_EMEA | 20 | 10691 | 10 | `s_m_Load_NETEX_SUPPLIER_BILL_ACCT_NOTE_SAM_EMEA` |

#### DG_291 — 2 members
- **Sources:** `USOC_BILLED`
- **Targets:** `USOC_BILLED`
- **Lookups:** `USOC_GL_ACCOUNT_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ACT_CD_SAM | 2 | 8469 | 5 | `s_m_Upd_NETEX_USOC_BILLED_GL_ACT_CD_SAM` |
| 2 | CD_SAM_EMEA | 2 | 8470 | 5 | `s_m_Upd_NETEX_USOC_BILLED_GL_ACT_CD_SAM_EMEA` |

#### DG_292 — 2 members
- **Sources:** `AE2E_ADC_KENAN_STG, AE2E_ADC_KENAN_STG1, AE2E_ADC_KENAN_STG2, AE2E_ADC_KENAN_STG3, AE2E_BILL_TAMER_PREP +5 more`
- **Targets:** `AE2E_ADC_KENAN_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ADC_KENAN_PREP | 42 | 12917 | 10 | `s_m_LOAD_AE2E_BW_DISCO_ADC_KENAN_PREP` |
| 2 | ADC_KENAN_PREP | 42 | 12923 | 10 | `s_m_LOAD_AE2E_BW_INST_ADC_KENAN_PREP` |

#### DG_293 — 2 members
- **Sources:** `AE2E_ISS_DELIMITED`
- **Targets:** `AE2E_ISS_HIST`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AE2E_ISS_ACQ | 1 | 680 | 2 | `s_m_LOAD_AE2E_ISS_ACQ` |
| 2 | ACQ_ONE_TIME | 1 | 681 | 2 | `s_m_LOAD_AE2E_ISS_ACQ_ONE_TIME` |

#### DG_294 — 2 members
- **Sources:** `AE2E_AM_OFFNET_MGR_PREP, AE2E_AM_OPENCI_PREP, AE2E_AM_OPENCI_PREP1, AE2E_JOB_LOG, AE2E_KENAN_STG +1 more`
- **Targets:** `AE2E_JOB_LOG, AE2E_KENAN_PREP`
- **Lookups:** `AE2E_KENAN_PREP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AE2E_KENAN_PREP | 38 | 12894 | 12 | `s_m_LOAD_AE2E_KENAN_PREP` |
| 2 | KENAN_PREP_WCD | 38 | 12895 | 12 | `s_m_LOAD_AE2E_KENAN_PREP_WCD` |

#### DG_295 — 2 members
- **Sources:** `AE2E_REVAMART_STG_1`
- **Targets:** `AE2E_REVAMART_STG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AE2E_REVAMART_STG | 8 | 9520 | 2 | `s_m_LOAD_AE2E_REVAMART_STG` |
| 2 | REVA_STG_ACT | 8 | 9521 | 2 | `s_m_LOAD_AE2E_REVA_STG_ACT` |

#### DG_296 — 2 members
- **Sources:** `AE2E_AM_OPENCI_PREP, AE2E_AM_OPENCI_PREP2, AE2E_JOB_LOG, AE2E_SIEBEL_SHARED_1, AE2E_SIEBEL_SHARED_12`
- **Targets:** `AE2E_AM_SIEBEL_PREP, AE2E_JOB_LOG`
- **Lookups:** `AE2E_AM_SIEBEL_PREP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AE2E_SIEBEL_PREP | 38 | 12896 | 12 | `s_m_LOAD_AE2E_SIEBEL_PREP` |
| 2 | SIEBEL_PREP_WCD | 38 | 12897 | 12 | `s_m_LOAD_AE2E_SIEBEL_PREP_WCD` |

#### DG_297 — 2 members
- **Sources:** `GL_LEDGER, GL_LEDGER1, GL_SEG2_PROFIT_CTR, GL_SEG2_PROFIT_CTR1, JOURNAL_HEADER +5 more`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT, DSL_AIM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ALLOC_EXPORT_FF | 24 | 11229 | 13 | `s_m_Load_NETEX_ALLOC_EXPORT_FF` |
| 2 | USF_EXPORT_FF | 24 | 11230 | 13 | `s_m_Load_NETEX_ALLOC_L3_USF_EXPORT_FF` |

#### DG_298 — 2 members
- **Sources:** `TASK`
- **Targets:** `CODS_WORKFLOW, TASK`
- **Lookups:** `EMPLOYEE, EMPLOYEE_LKP, PROCESS, PROD_LOCATION_REGION_LKP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AMDOCS_ODO_TASK | 8 | 9527 | 9 | `s_m_Load_AMDOCS_ODO_TASK` |
| 2 | Load_RSI_TASK | 23 | 11168 | 10 | `s_m_Load_RSI_TASK` |

#### DG_299 — 2 members
- **Sources:** `CDMTB_REVENUE_DETAIL_CABS, CDMTB_REVENUE_DETAIL_RJF, JOURNAL_HEADER, JOURNAL_LINE`
- **Targets:** `STG_F_REVENUE_DETAIL, STG_F_REVENUE_DETAIL_AMT`
- **Lookups:** `CALENDAR, DH_GL_ACCOUNT, DH_GL_BUSINESS_AREA, DH_GL_COMPANY, DH_GL_COST_CENTER +17 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AMT_MBS_Resource | 15 | 10251 | 34 | `s_m_Load_STG_FRD_STG_FRD_AMT_MBS_Resource` |
| 2 | AMT_RJF_Resource | 15 | 10255 | 34 | `s_m_Load_STG_FRD_STG_FRD_AMT_RJF_Resource` |

#### DG_300 — 2 members
- **Sources:** `FF_LOAD_STATUS`
- **Targets:** `APP_LOAD_CONTROL`
- **Lookups:** `ASL_LOAD_STATUS`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | APP_LOAD_CONTROL | 31 | 12348 | 5 | `s_m_Update_APP_LOAD_CONTROL` |
| 2 | LOAD_CONTROL_STATUS | 31 | 12349 | 5 | `s_m_Update_APP_LOAD_CONTROL_STATUS` |

#### DG_301 — 2 members
- **Sources:** `ARC_CKT_ORDER`
- **Targets:** `ARC_CKT_ORDER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ARC_CKT_ORDER | 1 | 5211 | 2 | `s_m_Load_SRC_EWH_ARC_CKT_ORDER` |
| 2 | ARC_CKT_ORDER | 1 | 5242 | 2 | `s_m_Load_SRC_STG_ARC_CKT_ORDER` |

#### DG_302 — 2 members
- **Sources:** `CSR_CIRCUIT_LISTING`
- **Targets:** `CODS_NETEX_STG, STG_CIRCUIT_ASG_TSC_ALLOC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASG_TSC_ALLOC | 2 | 8140 | 2 | `s_m_Load_NETEX_STG_CIRCUIT_ASG_TSC_ALLOC` |
| 2 | TSC_ALLOC_CTL | 2 | 8141 | 2 | `s_m_Load_NETEX_STG_CIRCUIT_ASG_TSC_ALLOC_CTL` |

#### DG_303 — 2 members
- **Sources:** `DUMMY_SRCE, DUMMY_SRCEE`
- **Targets:** `DUMMY_TGTT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASL_CORE_USECASE3 | 1 | 208 | 4 | `s_m_Check_App_Control_Status_ASL_CORE_USECASE3` |
| 2 | SDWF_SM_USECASE12 | 1 | 341 | 4 | `s_m_Check_App_Control_Status_CDL_ASL_SDWF_SM_USECASE12` |

#### DG_304 — 2 members
- **Sources:** `DUMMY_SRCE, DUMMY_SRCEE`
- **Targets:** `DUMMY_TGT, DUMMY_TGTT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASL_SDP_ORDER | 1 | 271 | 4 | `s_m_Check_App_Control_Status_ASL_SDP_ORDER` |
| 2 | Status_ASL_WM | 1 | 303 | 4 | `s_m_Check_App_Control_Status_ASL_WM` |

#### DG_305 — 2 members
- **Sources:** `ASSET_PRODUCT_COMPNT, ASSET_PRODUCT_COMPNT1, CIRCUIT_ASSET_STG`
- **Targets:** `ASSET_PRODUCT_COMPNT, CODS`
- **Lookups:** `ASSET_PRODUCT, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASSET_PRODUCT_COMPNT | 13 | 10052 | 13 | `s_m_Load_CABS_ASSET_PRODUCT_COMPNT` |
| 2 | ASSET_PRODUCT_COMPNT | 22 | 10993 | 13 | `s_m_Load_LUMEN_SERVICENOW_ASSET_PRODUCT_COMPNT` |

#### DG_306 — 2 members
- **Sources:** `ASSET_PRODUCT_COMPNT, CIRCUIT_ASSET_STG`
- **Targets:** `ASSET_PRODUCT_COMPNT`
- **Lookups:** `ASSET_PRODUCT, BANDWIDTH_XREF, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASSET_PRODUCT_COMPNT | 14 | 10140 | 10 | `s_m_Load_ENS_ASSET_PRODUCT_COMPNT` |
| 2 | ASSET_PRODUCT_COMPNT | 23 | 11162 | 10 | `s_m_Load_PROD_ASSET_PRODUCT_COMPNT` |

#### DG_307 — 2 members
- **Sources:** `ASSET_PRODUCT_ELEMENT, ASSET_PRODUCT_ELEMENT1, CIRCUIT_ASSET_STG, PROVIDERSOLUTION`
- **Targets:** `ASSET_PRODUCT_ELEMENT, CODS`
- **Lookups:** `ASSET_PRODUCT_COMPNT, CURRENCY_EXCHANGE_RATE, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASSET_PRODUCT_ELEMENT | 23 | 11131 | 10 | `s_m_Load_LUMEN_SERVICENOW_ASSET_PRODUCT_ELEMENT` |
| 2 | ASSET_PRODUCT_ELEMENT | 30 | 12169 | 10 | `s_m_Load_SWIFT_ASSET_PRODUCT_ELEMENT` |

#### DG_308 — 2 members
- **Sources:** `ASSET_PRODUCT_ENDPNT, CIRCUIT_ASSET_STG`
- **Targets:** `ASSET_PRODUCT_ENDPNT`
- **Lookups:** `ASSET_PRODUCT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASSET_PRODUCT_ENDPNT | 13 | 10053 | 10 | `s_m_Load_CABS_ASSET_PRODUCT_ENDPNT` |
| 2 | ASSET_PRODUCT_ENDPNT | 14 | 10138 | 10 | `s_m_Load_EIS_ASSET_PRODUCT_ENDPNT` |

#### DG_309 — 2 members
- **Sources:** `L3_TG_IP`
- **Targets:** `ASSIGNED_IP_ADDRESS, F_ASSIGNED_IP_ADDRESS_DUPLICATES`
- **Lookups:** `CUSTOMER, LEGACY_PRODUCT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASSIGNED_IP_ADDRESS | 21 | 10772 | 7 | `s_LOAD_ODS_ASSIGNED_IP_ADDRESS` |
| 2 | ASSIGNED_IP_ADDRESS | 21 | 10780 | 7 | `s_m_LOAD_ODS_ASSIGNED_IP_ADDRESS` |

#### DG_310 — 2 members
- **Sources:** `L3_ANI_DNIS`
- **Targets:** `ASSIGNED_PHONE_NBR, F_ASSIGNED_PHONE_NBR_DUPLICATES`
- **Lookups:** `BILL_TYPE, CUSTOMER, LEGACY_PRODUCT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASSIGNED_PHONE_NBR | 21 | 10773 | 8 | `s_LOAD_ODS_ASSIGNED_PHONE_NBR` |
| 2 | ASSIGNED_PHONE_NBR | 21 | 10781 | 8 | `s_m_LOAD_ODS_ASSIGNED_PHONE_NBR` |

#### DG_311 — 2 members
- **Sources:** `L3_TG_IP`
- **Targets:** `ASSIGNED_TRUNK_GROUP, F_ASSIGNED_TRUNK_GROUP_DUPLICATES`
- **Lookups:** `CUSTOMER, LEGACY_PRODUCT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ASSIGNED_TRUNK_GROUP | 21 | 10774 | 7 | `s_LOAD_ODS_ASSIGNED_TRUNK_GROUP` |
| 2 | ASSIGNED_TRUNK_GROUP | 21 | 10782 | 7 | `s_m_LOAD_ODS_ASSIGNED_TRUNK_GROUP` |

#### DG_312 — 2 members
- **Sources:** `ATTACHMENT, TICKET, TICKETEXPORTDATASET_20190128_W_AUDITID_LOCATOR_EMAIL_ADDRESS, TICKET_AUDIT_2, TICKET_RESPONSE`
- **Targets:** `ATTACHMENT, TICKET, TICKET_AUDIT_2, TICKET_RESPONSE`
- **Lookups:** `NATIONAL_CDC_CODES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ATTCHMNT_Green_2 | 1 | 5975 | 43 | `s_m_Load_TCKT_AUDT_RSPNS_ATTCHMNT_Green_2` |
| 2 | ATTCHMNT_Red_2 | 1 | 5977 | 43 | `s_m_Load_TCKT_AUDT_RSPNS_ATTCHMNT_Red_2` |

#### DG_313 — 2 members
- **Sources:** `LOGICAL_PORT_ATTR, PORT`
- **Targets:** `CODS_NETINV, LOGICAL_PORT_ATTR`
- **Lookups:** `LOGICAL_PORT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ATTR_AMDOCS_RM | 9 | 9677 | 10 | `s_m_Load_LOGICAL_PORT_ATTR_AMDOCS_RM` |
| 2 | PORT_ATTR_ARM | 9 | 9678 | 10 | `s_m_Load_LOGICAL_PORT_ATTR_ARM` |

#### DG_314 — 2 members
- **Sources:** `EQUIPMENT_ATTR, EQUIP_ATTR, PHYS_STRUCT`
- **Targets:** `CODS_NETINV, EQUIPMENT_ATTR`
- **Lookups:** `EQUIPMENT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ATTR_AMDOCS_RM | 29 | 11862 | 10 | `s_m_Load_EQUIPMENT_ATTR_AMDOCS_RM` |
| 2 | EQUIPMENT_ATTR_ARM | 29 | 11863 | 10 | `s_m_Load_EQUIPMENT_ATTR_ARM` |

#### DG_315 — 2 members
- **Sources:** `AUDIT_DETAILS, SUPPLIER_INV_AUDIT_DEF`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_AUDIT_DEF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AUDIT_DEF_SAM | 2 | 8142 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_AUDIT_DEF_SAM` |
| 2 | DEF_SAM_LATAM | 2 | 8144 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_AUDIT_DEF_SAM_LATAM` |

#### DG_316 — 2 members
- **Sources:** `FF_STG_PROD_PROF_ALLOC_RATIO_AUTOMATED_DYNAMIC, FF_STG_PROD_PROF_ALLOC_RATIO_AUTOMATED_DYNAMIC1, FF_STG_PROD_PROF_ALLOC_RATIO_AUTOMATED_DYNAMIC2, PROD_PROF_ALLOC_RATIO, PROD_PROF_ALLOC_RULE +1 more`
- **Targets:** `DUMMY_TGT, FF_AGGR_ACTUAL_SQL_TXT, FF_DUMMY, FF_PROD_PROF_ALLOC_RATIO_AUTOMATED_CODS_FINANCE_SQLOUTPUTS, FF_STG_PROD_PROF_ALLOC_RATIO_AUTOMATED_DYNAMIC +2 more`
- **Lookups:** `GL_SEG2_PROFIT_CTR, GL_SEG3_LOB, GL_SEG4_PRODUCT_DEPT, PROCESS_PARAMETER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | AUTOMATED_DYNAMIC_1 | 15 | 10222 | 59 | `s_m_Load_PROD_PROF_ALLOC_RATIO_AUTOMATED_DYNAMIC_1` |
| 2 | AUTOMATED_DYNAMIC_2 | 15 | 10223 | 59 | `s_m_Load_PROD_PROF_ALLOC_RATIO_AUTOMATED_DYNAMIC_2` |

#### DG_317 — 2 members
- **Sources:** `REPORT_INTERFACE_HIST, REPORT_IPVPN_LOGICAL_IF_HIST, W_3SCAPE`
- **Targets:** `FF_COUNT, FF_W_3SCAPE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Acquire_3Scape | 2 | 7781 | 11 | `s_m_Acquire_3Scape` |
| 2 | Acquire_3Scape_LATAM | 2 | 7782 | 11 | `s_m_Acquire_3Scape_LATAM` |

#### DG_318 — 2 members
- **Sources:** `SERVICE_LOOKUP`
- **Targets:** `W_BROADWING`
- **Lookups:** `BILLING_ACCOUNT, CUSTOMER, SBF_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Acquire_Broadwing_Srvc | 24 | 11186 | 7 | `s_m_Acquire_Broadwing_Srvc` |
| 2 | Acquire_W_BROADWING | 24 | 11188 | 7 | `s_m_Acquire_W_BROADWING` |

#### DG_319 — 2 members
- **Sources:** `MODIFIED SEGMENTS_EXTENDEDBUCKETS_CFS_PMT, MODIFIED_SEGMENTS_EXTENDEDBUCKETS_CFS_PMT`
- **Targets:** `FF_DUMMY_PAST_DUE_FILE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | App_BILLING_TICKETS | 1 | 143 | 3 | `s_m_Check_App_BILLING_TICKETS` |
| 2 | PAST_DUE_INVOICES | 1 | 535 | 3 | `s_m_Check_App_PAST_DUE_INVOICES` |

#### DG_320 — 2 members
- **Sources:** `REVENUE`
- **Targets:** `TGT_DATAMKTP_REVENUE_FF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BAN_Customer_file | 22 | 10984 | 2 | `s_m_Load_DATAMKTP_DSLF_REVENUE_BAN_Customer_file` |
| 2 | Product_Tier_file | 22 | 10985 | 2 | `s_m_Load_DATAMKTP_DSLF_REVENUE_Product_Tier_file` |

#### DG_321 — 2 members
- **Sources:** `JUR_DTL, LINE_ITEM_CODE_REF, OCC_ADJ_CIRCUIT_DTL, OCC_ADJ_DTL, OCC_TOTAL +1 more`
- **Targets:** `CODS_NETEX, USOC_BILLED`
- **Lookups:** `LINE_ITEM_CODE_REF, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, USOC_OCC_CATGRY, VVREF`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLED_OCC_Incrmntl | 21 | 10870 | 15 | `s_m_Load_NETEX_USOC_BILLED_OCC_Incrmntl` |
| 2 | OCC_Incrmntl_CTL | 21 | 10871 | 16 | `s_m_Load_NETEX_USOC_BILLED_OCC_Incrmntl_CTL` |

#### DG_322 — 2 members
- **Sources:** `OCC_DETAIL, USOC_BILLED`
- **Targets:** `USOC_BILLED`
- **Lookups:** `SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLED_OCC_SAM | 21 | 10872 | 10 | `s_m_Load_NETEX_USOC_BILLED_OCC_SAM` |
| 2 | OCC_SAM_EMEA | 21 | 10873 | 10 | `s_m_Load_NETEX_USOC_BILLED_OCC_SAM_EMEA` |

#### DG_323 — 2 members
- **Sources:** `BAN_VENDOR_LISTING, STG_SUPPLIER_BILLING_ACCOUNT, SUPPLIER_BILLING_ACCOUNT, SUPPLIER_BILLING_ACCOUNT1`
- **Targets:** `DUMMY_TARGET, STG_SUPPLIER_BILLING_ACCOUNT, SUPPLIER_BILLING_ACCOUNT`
- **Lookups:** `BAN_LEVEL_CREDIT, BAN_VENDOR_LISTING, GL_COMPANY, SUPPLIER, SUPPLIER_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_ACCOUNT_SAM | 14 | 10152 | 19 | `s_m_Load_NETEX_STG_SUPPLIER_BILLING_ACCOUNT_SAM` |
| 2 | ACCOUNT_SAM_EMEA | 14 | 10153 | 19 | `s_m_Load_NETEX_STG_SUPPLIER_BILLING_ACCOUNT_SAM_EMEA` |

#### DG_324 — 2 members
- **Sources:** `STG_SUPPLIER_BILLING_ACCOUNT, SUPPLIER_BILLING_ACCOUNT`
- **Targets:** `CODS_NETEX, SUPPLIER_BILLING_ACCOUNT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_ACCOUNT_SAM | 15 | 10215 | 12 | `s_m_Load_NETEX_SUPPLIER_BILLING_ACCOUNT_SAM` |
| 2 | ACCOUNT_SAM_EMEA | 15 | 10216 | 12 | `s_m_Load_NETEX_SUPPLIER_BILLING_ACCOUNT_SAM_EMEA` |

#### DG_325 — 2 members
- **Sources:** `SOURCE_BILLING_ACCOUNT, SOURCE_BILL_ACCT_XREF`
- **Targets:** `SOURCE_BILL_ACCT_XREF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_ACCT_XREF | 13 | 10064 | 9 | `s_m_Load_CRIS_SOURCE_BILLING_ACCT_XREF` |
| 2 | BILLING_ACCT_XREF | 19 | 10661 | 11 | `s_m_Load_RCR_SOURCE_BILLING_ACCT_XREF` |

#### DG_326 — 2 members
- **Sources:** `CUSTOMER_ID_ACCT_MAP, SOURCE_BILL_ACCT_XREF`
- **Targets:** `CODS, SOURCE_BILL_ACCT_XREF`
- **Lookups:** `SOURCE_BILLING_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_ACCT_XREF | 15 | 10206 | 9 | `s_m_Load_LATIS_SOURCE_BILLING_ACCT_XREF` |
| 2 | BILLING_ACCT_XREF | 19 | 10659 | 9 | `s_m_Load_PROD_SOURCE_BILLING_ACCT_XREF` |

#### DG_327 — 2 members
- **Sources:** `SOURCE_BILLING_ACCOUNT, SOURCE_BILL_ACCT_XREF`
- **Targets:** `CODS, SOURCE_BILL_ACCT_XREF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_ACCT_XREF | 17 | 10515 | 9 | `s_m_Load_ORACLE2E_FED_SOURCE_BILLING_ACCT_XREF` |
| 2 | BILLING_ACCT_XREF | 17 | 10516 | 9 | `s_m_Load_ORACLE2E_SOURCE_BILLING_ACCT_XREF` |

#### DG_328 — 2 members
- **Sources:** `STG_F_BILLING_ROLLUP_ENS, STG_F_BILLING_ROLLUP_ENS1`
- **Targets:** `FF_LOAD_STATUS, STG_F_BILLING_ROLLUP_ENS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILLING_ROLLUP_ENS | 1 | 5301 | 3 | `s_m_Load_STG_F_BILLING_ROLLUP_ENS` |
| 2 | ROLLUP_ENS_HISTORY | 1 | 5302 | 3 | `s_m_Load_STG_F_BILLING_ROLLUP_ENS_HISTORY` |

#### DG_329 — 2 members
- **Sources:** `ATTRIBUTE_REGISTRATION, BAN_ATTRIBUTE, SUPPLIER_BILL_ACCT_ATTR`
- **Targets:** `CODS_NETEX, SUPPLIER_BILL_ACCT_ATTR`
- **Lookups:** `SUPPLIER_BILLING_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILL_ACCT_ATTR | 16 | 10366 | 10 | `s_m_Load_NETEX_SUPPLIER_BILL_ACCT_ATTR` |
| 2 | ACCT_ATTR_CTL | 16 | 10367 | 10 | `s_m_Load_NETEX_SUPPLIER_BILL_ACCT_ATTR_CTL` |

#### DG_330 — 2 members
- **Sources:** `BILL_INVOICE_DETAIL`
- **Targets:** `CDC_BILL_INVOICE_TEMP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BILL_INVOICE_DET | 11 | 9819 | 2 | `s_m_LOAD_AE2E_CDC_BILL_INVOICE_DET` |
| 2 | BILL_INVOICE_HIST | 11 | 9820 | 2 | `s_m_LOAD_AE2E_CDC_BILL_INVOICE_HIST` |

#### DG_331 — 2 members
- **Sources:** `FMS_BLUE_SUBSCRIBER_DATACOM, FMS_BLUE_SUBSCRIBER_DATACOM1, FMS_FINANCE_ACCOUNT_STG, FMS_REVAMART1, FMS_REVAMART11`
- **Targets:** `FMS_BLUE_SUBSCRIBER_FEED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BLUE_SUBSCRIBER_FEED | 2 | 7904 | 4 | `s_m_LOAD_FMS_BLUE_SUBSCRIBER_FEED` |
| 2 | BLUE_SUBSCRIBER_DATACOM | 2 | 8097 | 4 | `s_m_Load_FMS_BLUE_SUBSCRIBER_DATACOM` |

#### DG_332 — 2 members
- **Sources:** `CDW_LOAD_RULE, CUSTOMER, SOURCE_CONTACT, SOURCE_CONTACT1`
- **Targets:** `CODS, SOURCE_CONTACT`
- **Lookups:** `EMPLOYEE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BM_SOURCE_CONTACT | 9 | 9641 | 23 | `s_m_Load_BM_SOURCE_CONTACT` |
| 2 | SAM_SOURCE_CONTACT | 9 | 9710 | 24 | `s_m_Load_SAM_SOURCE_CONTACT` |

#### DG_333 — 2 members
- **Sources:** `DUMMY_SRCE`
- **Targets:** `M_CHECK_APP_CONTROL_STATUS_BLUEMARBLE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BM_entry_check | 1 | 7063 | 4 | `s_m_app_control_BM_entry_check` |
| 2 | control_check_BM | 1 | 7064 | 4 | `s_m_app_control_check_BM` |

#### DG_334 — 2 members
- **Sources:** `ASL_LOAD_STATUS, ETL_PARAMETER`
- **Targets:** `FF_PARAMETER_FILE`
- **Lookups:** `ETL_PARAMETER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BPC_CABS_SW | 5 | 9204 | 6 | `s_m_Generate_Parameter_File_BPC_CABS_SW` |
| 2 | KEY_ID_TEMP | 5 | 9210 | 6 | `s_m_Generate_Parameter_File_FRD_JRNL_KEY_ID_TEMP` |

#### DG_335 — 2 members
- **Sources:** `AE2E_CODS_STG, AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG`
- **Targets:** `AE2E_CODS_PREP, AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG`
- **Lookups:** `AE2E_SYSTEM`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BPMS_CODS_PREP | 34 | 12602 | 7 | `s_m_Load_AE2E_ORDER_TO_BPMS_CODS_PREP` |
| 2 | VBR_CODS_PREP | 34 | 12603 | 7 | `s_m_Load_AE2E_ORDER_TO_VBR_CODS_PREP` |

#### DG_336 — 2 members
- **Sources:** `AE2E_BTP_STG3, AE2E_BTP_STG31, AE2E_JOB_LOG, AE2E_XLINK_CV_PREP, AE2E_XLINK_CV_PREP1 +1 more`
- **Targets:** `AE2E_BILL_TAMER_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BRDINSTALL_BTP_PREP | 39 | 12907 | 10 | `s_m_LOAD_AE2E_BRDINSTALL_BTP_PREP` |
| 2 | DISCO_BTP_PREP | 39 | 12908 | 10 | `s_m_LOAD_AE2E_BRD_DISCO_BTP_PREP` |

#### DG_337 — 2 members
- **Sources:** `DUMMY_NBR_SRC, WTX_BRIDGE_KEY_CABS`
- **Targets:** `DUMMY_TGT, ETL_PARAMETER`
- **Lookups:** `ETL_PARAMETER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BRIDGE_KEY_CABS | 1 | 6512 | 9 | `s_m_Load_WTX_BRIDGE_KEY_CABS` |
| 2 | BRIDGE_KEY_ZUORA | 1 | 6517 | 8 | `s_m_Load_WTX_BRIDGE_KEY_ZUORA` |

#### DG_338 — 2 members
- **Sources:** `DUMMY_NBR_SRC, WTX_BRIDGE_KEY_RJF`
- **Targets:** `DUMMY_TGT, ETL_PARAMETER`
- **Lookups:** `ETL_PARAMETER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BRIDGE_KEY_MBS | 1 | 6514 | 9 | `s_m_Load_WTX_BRIDGE_KEY_MBS` |
| 2 | BRIDGE_KEY_RJF | 1 | 6516 | 9 | `s_m_Load_WTX_BRIDGE_KEY_RJF` |

#### DG_339 — 2 members
- **Sources:** `COMMON_OP_VENDOR_REF`
- **Targets:** `BTP_OPERATING_SUPPLIER`
- **Lookups:** `BTP_OPERATING_SUPPLIER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BTP_OPERATING_SUPPLIER | 2 | 8138 | 5 | `s_m_Load_NETEX_BTP_OPERATING_SUPPLIER` |
| 2 | OPERATING_SUPPLIER_CTL | 2 | 8139 | 5 | `s_m_Load_NETEX_BTP_OPERATING_SUPPLIER_CTL` |

#### DG_340 — 2 members
- **Sources:** `BUS_STAT_TEMP_FILE_SRC`
- **Targets:** `BUSINESS_STAT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BUSINESS_STAT_CHI | 1 | 1279 | 2 | `s_m_Load_BUSINESS_STAT_CHI` |
| 2 | BUSINESS_STAT_UP | 1 | 1280 | 3 | `s_m_Load_BUSINESS_STAT_UP` |

#### DG_341 — 2 members
- **Sources:** `BUYING_PLAN_LOOKUP, SUPPLIER_CIRCUIT, SUPPLIER_CIRCUIT2`
- **Targets:** `CODS_NETEX, RTR_DEFAULT1, RTR_PASS, SUPPLIER_CIRCUIT`
- **Lookups:** `SUPPLIER_CIRCUIT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | BUYING_PLAN_SAM | 1 | 6869 | 17 | `s_m_Upd_NETEX_BUYING_PLAN_SAM` |
| 2 | SUPPLIER_CIRCUIT_CTL | 1 | 6871 | 17 | `s_m_Upd_NETEX_SUPPLIER_CIRCUIT_CTL` |

#### DG_342 — 2 members
- **Sources:** `PRODUCT, PRODUCT_SPECIFICATION`
- **Targets:** `CODS, PRODUCT_SPECIFICATION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CABS_PRODUCT_SPECIFICATION | 3 | 8808 | 10 | `s_m_Load_CABS_PRODUCT_SPECIFICATION` |
| 2 | SFENT_PRODUCT_SPECIFICATION | 3 | 8926 | 10 | `s_m_Load_SFENT_PRODUCT_SPECIFICATION` |

#### DG_343 — 2 members
- **Sources:** `CACHING_PUBLISHER_STAGE`
- **Targets:** `DUMMY`
- **Lookups:** `CACHING_HARVEST`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CACHING_COSERVER_PUBLISHER | 2 | 7886 | 6 | `s_m_LOAD_AL_IL_CACHING_COSERVER_PUBLISHER` |
| 2 | CACHING_SUBSCRIBER_PUBLISHER | 2 | 7891 | 6 | `s_m_LOAD_AL_IL_CACHING_SUBSCRIBER_PUBLISHER` |

#### DG_344 — 2 members
- **Sources:** `UP_SOURCE_UPDATE`
- **Targets:** `TEMP_CALL_DETAIL_PROCESS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CALL_DETAIL_PROCESS | 1 | 6006 | 4 | `s_m_Load_TEMP_CALL_DETAIL_PROCESS` |
| 2 | CALL_DETAIL_PROCESS | 1 | 7056 | 4 | `s_m_X_Load_TEMP_CALL_DETAIL_PROCESS` |

#### DG_345 — 2 members
- **Sources:** `AR_CASH_BATCH, AR_CASH_RECEIPT, CDMTB_REVENUE_DETAIL_RJF, JOURNAL_HEADER, JOURNAL_LINE +2 more`
- **Targets:** `DSL_FINANCE, RECON_CASH_RECEIPT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CASH_RECEIPT_CRIS | 15 | 10225 | 9 | `s_m_Load_RECON_CASH_RECEIPT_CRIS` |
| 2 | CASH_RECEIPT_ENS | 15 | 10226 | 9 | `s_m_Load_RECON_CASH_RECEIPT_ENS` |

#### DG_346 — 2 members
- **Sources:** `CALL_DETAIL, CALL_DETAIL1, CALL_DETAIL2`
- **Targets:** `FF_CDRW_FACT`
- **Lookups:** `D_CUSTOMER, X_KENAN_PROD_CD_MAPPING`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CDD_Unload | 4 | 9035 | 7 | `s_m_CDD_Unload` |
| 2 | Call_Detail_Delta | 22 | 11072 | 7 | `s_m_Unload_CDRW_Call_Detail_Delta` |

#### DG_347 — 2 members
- **Sources:** `D_TRUNKGROUP, FF_CDNA_SRCE`
- **Targets:** `D_TRUNKGROUP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CDNA_Dims_TG | 1 | 113 | 7 | `s_m_CDNA_Dims_TG` |
| 2 | CDNA_Dims_TG2 | 1 | 114 | 7 | `s_m_CDNA_Dims_TG2` |

#### DG_348 — 2 members
- **Sources:** `CALL_DETAIL`
- **Targets:** `FF_CDRW_D_CUSTOMER, FF_CDRW_D_INFO_DIGIT, FF_CDRW_D_NPA_NXX, FF_CDRW_D_PARTITION, FF_CDRW_D_SURCHARGE +2 more`
- **Lookups:** `D_CUSTOMER, X_KENAN_PROD_CD_MAPPING`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CD_Unload | 4 | 9037 | 23 | `s_m_CD_Unload` |
| 2 | CDRW_Call_Detail | 22 | 11071 | 23 | `s_m_Unload_CDRW_Call_Detail` |

#### DG_349 — 2 members
- **Sources:** `REP_TASK_INST_RUN`
- **Targets:** `CDW_COMMON, CDW_COMMON_PROCESS_STATUS, PROCESS_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CENTER_PROCESS_STATUS | 1 | 2109 | 2 | `s_m_Load_DSL_CALL_CENTER_PROCESS_STATUS` |
| 2 | DSP_PROCESS_STATUS | 1 | 2112 | 2 | `s_m_Load_DSP_PROCESS_STATUS` |

#### DG_350 — 2 members
- **Sources:** `CHARGE, CHARGE1, SI_CHARGEINSTANCE, SI_PRODUCTINSTANCE, SL_ORDER`
- **Targets:** `CHARGE, DRIVING_KEY1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CHARGE_VC_ISOURCE | 2 | 8013 | 21 | `s_m_Load_CHARGE_VC_ISOURCE` |
| 2 | CHARGE_VOICE_COMPLETE | 2 | 8014 | 22 | `s_m_Load_CHARGE_VOICE_COMPLETE` |

#### DG_351 — 2 members
- **Sources:** `STG_CIRCUIT_ASG_TSC_ALLOC, SUPPLIER_BILLING_ACCOUNT, SUPPLIER_BILLING_ACCOUNT1, SUPPLIER_CIRCUIT, SUPPLIER_CIRCUIT1 +1 more`
- **Targets:** `CODS_NETEX, SUPPLIER_CIRCUIT`
- **Lookups:** `INVOICE, SUPPLIER_DISPUTE_ACTIVITY, SUPPLIER_INVOICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CIRCUIT_ASG_AMT | 18 | 10580 | 18 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ASG_AMT` |
| 2 | ASG_AMT_CTL | 18 | 10581 | 18 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ASG_AMT_CTL` |

#### DG_352 — 2 members
- **Sources:** `SUPPLIER_CIRCUIT`
- **Targets:** `CODS_NETEX, SUPPLIER_CIRCUIT`
- **Lookups:** `SUPPLIER_BILLING_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CIRCUIT_ILEC_COLO | 16 | 10368 | 9 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ILEC_COLO` |
| 2 | ILEC_COLO_CTL | 16 | 10369 | 9 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_ILEC_COLO_CTL` |

#### DG_353 — 2 members
- **Sources:** `ASL_SYNCHRONOSS, OCC_DETAIL, SUPPLIER, SUPPLIER_CIRCUIT`
- **Targets:** `DUMMY_TARGET, SUPPLIER_CIRCUIT, SUPPLIER_CIRCUIT_1`
- **Lookups:** `BAN_VENDOR_LISTING, SUPPLIER_BILLING_ACCOUNT, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CIRCUIT_OCC_SAM | 16 | 10373 | 15 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_OCC_SAM` |
| 2 | OCC_SAM_EMEA | 16 | 10374 | 15 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_OCC_SAM_EMEA` |

#### DG_354 — 2 members
- **Sources:** `ASSET_PRODUCT, ASSET_PRODUCT1, SERVICE_LOOKUP_MVW`
- **Targets:** `ASSET_PRODUCT`
- **Lookups:** `BANDWIDTH_XREF, BILLING_ACCOUNT, CUSTOMER, TABLE_X_CONTRACT_DOCUMENT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CLARIFY_ASSET_PRODUCT | 9 | 9623 | 10 | `s_m_LOAD_LEGACY_CLARIFY_ASSET_PRODUCT` |
| 2 | BW_ASSET_PRODUCT | 12 | 10006 | 10 | `s_m_Load_LEGACY_CIRCUITVISION_BW_ASSET_PRODUCT` |

#### DG_355 — 2 members
- **Sources:** `ASSET_RELATIONSHIP, ASSET_RELATIONSHIP1, TRAIL_ENDPNT_DESIGN`
- **Targets:** `ASSET_RELATIONSHIP`
- **Lookups:** `ASSET_PRODUCT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CLARIFY_ASSET_RELATIONSHIP | 14 | 10150 | 10 | `s_m_Load_LEGACY_CLARIFY_ASSET_RELATIONSHIP` |
| 2 | WILTEL_ASSET_RELATIONSHIP | 14 | 10151 | 10 | `s_m_Load_LEGACY_OPENCI_WILTEL_ASSET_RELATIONSHIP` |

#### DG_356 — 2 members
- **Sources:** `PRODUCT_SPECIFICATION, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_SPECIFICATION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CLARIFY_PRODUCT_SPECIFICATION | 4 | 9077 | 11 | `s_m_Load_CLARIFY_PRODUCT_SPECIFICATION` |
| 2 | ORACLE2E_PRODUCT_SPECIFICATION | 4 | 9116 | 11 | `s_m_Load_ORACLE2E_PRODUCT_SPECIFICATION` |

#### DG_357 — 2 members
- **Sources:** `ORDER_CNAM_LIDB_FEATURES, ORDER_CNAM_LIDB_FEATURES1, ORDER_CNAM_LIDB_FEATURES4`
- **Targets:** `DRIVING_KEY1, FF_LOAD_STATUS, ORDER_CNAM_LIDB_FEATURES`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CNAM_LIDB_FEATURES | 1 | 783 | 16 | `s_m_LOAD_ORDER_CNAM_LIDB_FEATURES` |
| 2 | CNAM_LIDB_FEATURES | 1 | 3882 | 16 | `s_m_Load_ORDER_CNAM_LIDB_FEATURES` |

#### DG_358 — 2 members
- **Sources:** `BILLING_PRODUCT_COMPNT, NRC, NRC1, PRODUCT`
- **Targets:** `BILL_PROD_COMPNT_CHARGE, CODS_BILLING_STG, FF_LOAD_STATUS, NRC, STG_NRC_PRODUCT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COMPNT_CHARGE_IDC | 15 | 10165 | 14 | `s_m_Load_BILL_PROD_COMPNT_CHARGE_IDC` |
| 2 | COMPNT_CHARGE_KENANFX | 15 | 10166 | 14 | `s_m_Load_BILL_PROD_COMPNT_CHARGE_KENANFX` |

#### DG_359 — 2 members
- **Sources:** `BILLING_PRODUCT_COMPNT_CRIS, BILLING_PRODUCT_COMPNT_CRIS1, BILLING_PRODUCT_COMPNT_CRIS2`
- **Targets:** `BILLING_PRODUCT_COMPNT_CRIS, CODS_BILLING_STG, STG_BILLING_PRODUCT_COMPNT_CRIS, STG_BILL_PRODUCT_COMPNT_CRIS`
- **Lookups:** `ASSET_PRODUCT, ASSET_PRODUCT_COMPNT, BANDWIDTH_XREF, CDW_CPROD10T_DLY_GLT, CRTS_B539_DSCNCT_RSN_TYPE +5 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COMPNT_CRIS_DRC | 30 | 12099 | 14 | `s_m_Load_BILLING_PRODUCT_COMPNT_CRIS_DRC` |
| 2 | PRODUCT_COMPNT_CRIS | 30 | 12240 | 14 | `s_m_load_BILLING_PRODUCT_COMPNT_CRIS` |

#### DG_360 — 2 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, ORDER_PRODUCT_COMPNT, PRODUCT_COMPNT_INCR_AMT, PRODUCT_COMPNT_INCR_AMT1`
- **Targets:** `PRODUCT_COMPNT_INCR_AMT`
- **Lookups:** `CUSTOMER_ORDER, L3AR_GL_GOV_REV_VALUES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COMPNT_INCR_AMT | 12 | 9939 | 10 | `s_m_LOAD_NETWORX_PRODUCT_COMPNT_INCR_AMT` |
| 2 | COMPNT_INCR_AMT | 19 | 10620 | 10 | `s_m_Load_EIS_PRODUCT_COMPNT_INCR_AMT` |

#### DG_361 — 2 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, ORDER_PRODUCT_COMPNT, PRODUCT_COMPNT_INCR_AMT, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_COMPNT_INCR_AMT`
- **Lookups:** `CUSTOMER_ORDER, L3AR_GL_GOV_REV_VALUES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COMPNT_INCR_AMT | 14 | 10120 | 12 | `s_m_Load_CLARIFY_PRODUCT_COMPNT_INCR_AMT` |
| 2 | COMPNT_INCR_AMT | 23 | 11151 | 12 | `s_m_Load_ORACLE2E_PRODUCT_COMPNT_INCR_AMT` |

#### DG_362 — 2 members
- **Sources:** `NETWORK_COMPONENT, TOPOLOGY`
- **Targets:** `CODS_NETINV, NETWORK_COMPONENT`
- **Lookups:** `NETWORK, TRAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | COMPONENT_AMDOCS_RM | 34 | 12621 | 10 | `s_m_Load_NETWORK_COMPONENT_AMDOCS_RM` |
| 2 | NETWORK_COMPONENT_ARM | 34 | 12622 | 10 | `s_m_Load_NETWORK_COMPONENT_ARM` |

#### DG_363 — 2 members
- **Sources:** `CDW_LOAD_RULE, CUSTOMER, SOURCE_CONTACT, SOURCE_CONTACT1, S_CONTACT`
- **Targets:** `CODS, SOURCE_CONTACT`
- **Lookups:** `EMPLOYEE, EMPLOYEE_LKP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CONTACT_SOURCE_CONTACT | 9 | 9666 | 23 | `s_m_Load_GLOBAL_CONTACT_SOURCE_CONTACT` |
| 2 | SIEBEL_SOURCE_CONTACT | 21 | 10910 | 23 | `s_m_Load_SIEBEL_SOURCE_CONTACT` |

#### DG_364 — 2 members
- **Sources:** `TASK, TASK_ATTR`
- **Targets:** `CODS_WORKFLOW, TASK_ATTR`
- **Lookups:** `TASK`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CORE_TASK_ATTR | 31 | 12286 | 8 | `s_m_Load_CORE_TASK_ATTR` |
| 2 | WORKMATE_TASK_ATTR | 31 | 12340 | 10 | `s_m_Load_WORKMATE_TASK_ATTR` |

#### DG_365 — 2 members
- **Sources:** `X_RPT_TG_MEMBER`
- **Targets:** `RPT_LM_CPCTY_ASGNMT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CPCTY_ASGNMT_GETS | 1 | 4767 | 2 | `s_m_Load_RPT_LM_CPCTY_ASGNMT_GETS` |
| 2 | CPCTY_ASGNMT_PRO | 1 | 4768 | 3 | `s_m_Load_RPT_LM_CPCTY_ASGNMT_PRO` |

#### DG_366 — 2 members
- **Sources:** `STG_U_F_MANUAL_CREDIT_TAX`
- **Targets:** `FL_GENERATED_PARAMETERS, STG_U_F_MANUAL_CREDIT_TAX`
- **Lookups:** `BILLING_ACCOUNT, CMF, TAX_GEOCODES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CREDIT_FILE_ADC | 24 | 11306 | 19 | `s_m_VERIFY_MANUAL_CREDIT_FILE_ADC` |
| 2 | CREDIT_FILE_CDC | 24 | 11307 | 19 | `s_m_VERIFY_MANUAL_CREDIT_FILE_CDC` |

#### DG_367 — 2 members
- **Sources:** `F_CDR, VSUM_SRC`
- **Targets:** `FF_BCI_CSR_REPORT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CSR_Report_AUTO | 18 | 10536 | 1 | `s_m_BCI_CSR_Report_AUTO` |
| 2 | CSR_Report_MANUAL | 18 | 10537 | 1 | `s_m_BCI_CSR_Report_MANUAL` |

#### DG_368 — 2 members
- **Sources:** `TGT_VOICE_SWITCH, VOICE_SWITCH`
- **Targets:** `CODS_TN, VOICE_SWITCH`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CTS_VOICE_SWITCH | 1 | 1650 | 12 | `s_m_Load_CNUM_CTS_VOICE_SWITCH` |
| 2 | LOCAL_VOICE_SWITCH | 1 | 1651 | 12 | `s_m_Load_CNUM_LOCAL_VOICE_SWITCH` |

#### DG_369 — 2 members
- **Sources:** `SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL11`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CURR_DUE_DIFF | 20 | 10719 | 14 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_CURR_DUE_DIFF` |
| 2 | DUE_DIFF_CTL | 20 | 10720 | 14 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_CURR_DUE_DIFF_CTL` |

#### DG_370 — 2 members
- **Sources:** `AE2E_ENDSTATE_SIEBEL_PREP, AE2E_JOB_LOG, AE2E_ONNET_GRANITE_PREP, AE2E_SAVVION_STG, AE2E_SAVVION_STG2`
- **Targets:** `AE2E_JOB_LOG, AE2E_SAVVION_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSDIS_BPMS_PREP | 5 | 9181 | 10 | `s_m_AE2E_UNITY_ONNET_CUSDIS_BPMS_PREP` |
| 2 | CUSINS_BPMS_PREP | 5 | 9182 | 10 | `s_m_AE2E_UNITY_ONNET_CUSINS_BPMS_PREP` |

#### DG_371 — 2 members
- **Sources:** `AE2E_CLARIFY_PREP, AE2E_CLARIFY_PREP1, AE2E_CLARIFY_STG, AE2E_JOB_LOG, AE2E_ONNET_GRANITE_PREP +4 more`
- **Targets:** `AE2E_CLARIFY_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSDIS_CS_PREP | 3 | 8793 | 17 | `s_m_Load_AE2E_UNITY_ONT_CUSDIS_CS_PREP` |
| 2 | CUSINS_CS_PREP | 3 | 8794 | 17 | `s_m_Load_AE2E_UNITY_ONT_CUSINS_CS_PREP` |

#### DG_372 — 2 members
- **Sources:** `AE2E_JOB_LOG, AE2E_ONNET_GRANITE_STG, AE2E_UNIX_JOB_LOG`
- **Targets:** `AE2E_JOB_LOG, AE2E_ONNET_GRANITE_PREP, AE2E_UNIX_JOB_LOG`
- **Lookups:** `AE2E_SYSTEM`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSDIS_GRANITE_PREP | 2 | 7944 | 7 | `s_m_Load_AE2E_UNITY_ONNET_CUSDIS_GRANITE_PREP` |
| 2 | CUSINS_GRANITE_PREP | 2 | 7945 | 7 | `s_m_Load_AE2E_UNITY_ONNET_CUSINS_GRANITE_PREP` |

#### DG_373 — 2 members
- **Sources:** `AE2E_CLARIFY_PREP, AE2E_CLARIFY_PREP1, AE2E_CLARIFY_PREP2, AE2E_JOB_LOG, AE2E_KENAN_PREP +6 more`
- **Targets:** `AE2E_JOB_LOG, AE2E_KENAN_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSDIS_KENAN_PREP | 43 | 12933 | 26 | `s_m_AE2E_UNITY_ONNET_CUSDIS_KENAN_PREP` |
| 2 | CUSINS_KENAN_PREP | 43 | 12934 | 26 | `s_m_AE2E_UNITY_ONNET_CUSINS_KENAN_PREP` |

#### DG_374 — 2 members
- **Sources:** `AE2E_JOB_LOG, AE2E_ONNET_GRANITE_PREP, AE2E_ONNET_GRANITE_PREP1, AE2E_PIPELINE_PREP, AE2E_PIPELINE_STG +1 more`
- **Targets:** `AE2E_JOB_LOG, AE2E_PIPELINE_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSDIS_PPL_PREP | 3 | 8791 | 11 | `s_m_Load_AE2E_UNITY_ONNET_CUSDIS_PPL_PREP` |
| 2 | CUSINS_PPL_PREP | 3 | 8792 | 11 | `s_m_Load_AE2E_UNITY_ONNET_CUSINS_PPL_PREP` |

#### DG_375 — 2 members
- **Sources:** `AE2E_JOB_LOG, AE2E_KENAN_PREP, AE2E_KENAN_PREP1, AE2E_KENAN_PREP2, AE2E_KENAN_PREP4 +4 more`
- **Targets:** `AE2E_JOB_LOG, AE2E_KENAN_PCID1, AE2E_REVAMART_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSDIS_REVMART_PREP | 44 | 12939 | 19 | `s_m_AE2E_UNITY_ONNET_CUSDIS_REVMART_PREP` |
| 2 | CUSINS_REVMART_PREP | 44 | 12940 | 19 | `s_m_AE2E_UNITY_ONNET_CUSINS_REVMART_PREP` |

#### DG_376 — 2 members
- **Sources:** `AE2E_ENDSTATE_SIEBEL_STG, AE2E_ENDSTATE_SIEBEL_STG1, AE2E_ENDSTATE_SIEBEL_STG11, AE2E_ENDSTATE_SIEBEL_STG2, AE2E_ENDSTATE_SIEBEL_STG4 +5 more`
- **Targets:** `AE2E_ENDSTATE_SIEBEL_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSDIS_SIEBEL_PREP | 4 | 9031 | 18 | `s_m_AE2E_UNITY_ONNET_CUSDIS_SIEBEL_PREP` |
| 2 | CUSINS_SIEBEL_PREP | 4 | 9032 | 18 | `s_m_AE2E_UNITY_ONNET_CUSINS_SIEBEL_PREP` |

#### DG_377 — 2 members
- **Sources:** `CUSTOMER_ORDER`
- **Targets:** `CODS, CUSTOMER_ORDER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSTOMER_ORDER_BLUEMARBLE | 1 | 6989 | 3 | `s_m_Update_ODS_CUSTOMER_ORDER_BLUEMARBLE` |
| 2 | CUSTOMER_ORDER_RSOR | 1 | 7000 | 3 | `s_m_Update_ODS_CUSTOMER_ORDER_RSOR` |

#### DG_378 — 2 members
- **Sources:** `CUSTOMER, CUSTOMER_ORDER, CUSTOMER_ORDER_PRODUCT`
- **Targets:** `V_CUSTOMER_ORDER_PRODUCT`
- **Lookups:** `CUSTOMER, CUSTOMER_ORDER_PRODUCT, EMPLOYEE, GL_MGMT_PRODUCT, GL_SEGMENT_PRODUCT_XREF +6 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUSTOMER_ORDER_PRODUCT | 31 | 12336 | 33 | `s_m_Load_V_CUSTOMER_ORDER_PRODUCT` |
| 2 | CUSTOMER_ORDER_PRODUCT1 | 31 | 12337 | 33 | `s_m_Load_V_CUSTOMER_ORDER_PRODUCT1` |

#### DG_379 — 2 members
- **Sources:** `CUST_INCR_MARGIN, CUST_INCR_MARGIN_TGT`
- **Targets:** `CUST_INCR_MARGIN, DSL_MARGIN`
- **Lookups:** `CUSTOMER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUST_INCR_MARGIN | 21 | 10799 | 13 | `s_m_Load_CUST_INCR_MARGIN` |
| 2 | INCR_MARGIN_OneTimeLoad | 21 | 10800 | 13 | `s_m_Load_CUST_INCR_MARGIN_OneTimeLoad` |

#### DG_380 — 2 members
- **Sources:** `CUST_SEG_MARGIN, CUST_SEG_MARGIN1, CUST_SEG_MARGIN2, CUST_SEG_MARGIN_CCDW, F_BILLING_DETAIL_CCDW +1 more`
- **Targets:** `CUST_SEG_MARGIN, DSL_MARGIN`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, CUSTOMER, GL_CUSTOMER_SEGMENT, GL_SEG1_COMPANY`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CUST_SEG_MARGIN | 21 | 10803 | 34 | `s_m_Load_CUST_SEG_MARGIN` |
| 2 | SEG_MARGIN_OneTimeLoad | 21 | 10804 | 34 | `s_m_Load_CUST_SEG_MARGIN_OneTimeLoad` |

#### DG_381 — 2 members
- **Sources:** `CV_USRDTA_LINK`
- **Targets:** `CV_USRDTA_LINK`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CV_USRDTA_LINK | 1 | 5245 | 2 | `s_m_Load_SRC_STG_CV_USRDTA_LINK` |
| 2 | CV_USRDTA_LINK | 1 | 5298 | 2 | `s_m_Load_STG_EWH_CV_USRDTA_LINK` |

#### DG_382 — 2 members
- **Sources:** `CV_USRDTA_VALUE`
- **Targets:** `CV_USRDTA_VALUE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | CV_USRDTA_VALUE | 1 | 5246 | 2 | `s_m_Load_SRC_STG_CV_USRDTA_VALUE` |
| 2 | CV_USRDTA_VALUE | 1 | 5299 | 2 | `s_m_Load_STG_EWH_CV_USRDTA_VALUE` |

#### DG_383 — 2 members
- **Sources:** `BATCH_FILE_MAP`
- **Targets:** `FF_PE_DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Check_BFM_up | 3 | 8967 | 1 | `s_m_PE_Check_BFM_up` |
| 2 | Check_BFM_vero | 3 | 8968 | 1 | `s_m_PE_Check_BFM_vero` |

#### DG_384 — 2 members
- **Sources:** `M_VSUM_PROCESS_CONTROL`
- **Targets:** `FF_CTRL_TBL_OUT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Check_Prev_Run | 2 | 7770 | 1 | `s_m_4_CDD_Check_Prev_Run` |
| 2 | Check_Prev_Run | 2 | 7772 | 1 | `s_m_4_CD_Check_Prev_Run` |

#### DG_385 — 2 members
- **Sources:** `INV_INVESTMENTS, INV_INVESTMENTS3`
- **Targets:** `CLARITY, INV_INVESTMENTS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Clarity_Inv_Investments | 1 | 1972 | 8 | `s_m_Load_Clarity_Inv_Investments` |
| 2 | Inv_Investments_old | 1 | 1973 | 8 | `s_m_Load_Clarity_Inv_Investments_old` |

#### DG_386 — 2 members
- **Sources:** `SUPPLIER_CIRCUIT`
- **Targets:** `CODS_NETEX, TGT_CROSS_ACNA_HDR_TRLR, TGT_NETEX_CROSS_ACNA, USOC_BILLED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Cross_ACNA_Report | 17 | 10492 | 10 | `s_m_Load_NETEX_Cross_ACNA_Report` |
| 2 | Report_onetime_upd | 17 | 10493 | 10 | `s_m_Load_NETEX_Cross_ACNA_Report_onetime_upd` |

#### DG_387 — 2 members
- **Sources:** `PROCESS_DATASLOT_KEY_VALUES, PROCESS_DATASLOT_KEY_VALUES1, PROCESS_DATASLOT_KEY_VALUES3`
- **Targets:** `PROCESS_DATASLOT_KEY_VALUES, SAVVION_SBM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DATASLOT_KEY_VALUES | 1 | 4314 | 12 | `s_m_Load_PROCESS_DATASLOT_KEY_VALUES` |
| 2 | KEY_VALUES_NRT | 1 | 4315 | 12 | `s_m_Load_PROCESS_DATASLOT_KEY_VALUES_NRT` |

#### DG_388 — 2 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_DR_AMT`
- **Lookups:** `ACCRUAL_CHARGE_MJE_EXPORT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DEBIT_ADJ_FF | 25 | 11393 | 3 | `s_m_Load_NETEX_ALLOC_DEBIT_ADJ_FF` |
| 2 | DEBIT_ADJ_FF | 25 | 11395 | 3 | `s_m_Load_NETEX_ALLOC_L3_USF_DEBIT_ADJ_FF` |

#### DG_389 — 2 members
- **Sources:** `CSR_ACCOUNT, INVOICE, LINE_ITEM, LINE_ITEM_JUR_DTL, SUPPLIER_INVOICE +2 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_ACCT_MRC | 17 | 10510 | 21 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ACCT_MRC` |
| 2 | ACCT_MRC_CTL | 17 | 10511 | 21 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ACCT_MRC_CTL` |

#### DG_390 — 2 members
- **Sources:** `INVOICE, OCC_ADJ_CIRCUIT_DTL, OCC_ADJ_DTL, RECONCILE_ACTION, SUPPLIER_INV_DETAIL +1 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_BILLING_ACCOUNT, SUPPLIER_CIRCUIT, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_ADJ_ACC | 20 | 10702 | 18 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ADJ_ACC` |
| 2 | ADJ_ACC_CTL | 20 | 10703 | 18 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ADJ_ACC_CTL` |

#### DG_391 — 2 members
- **Sources:** `ASG_OCL, CSR_ACCOUNT, INVOICE, LINE_ITEM, LINE_ITEM_JUR_DTL +4 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_CIRCUIT, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_ASG_MRC | 20 | 10707 | 25 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ASG_MRC` |
| 2 | ASG_MRC_CTL | 20 | 10708 | 25 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ASG_MRC_CTL` |

#### DG_392 — 2 members
- **Sources:** `BALANCE_ENTRY, RECONCILE_ACTION, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL1`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_BALANCE_ENTRY | 20 | 10711 | 15 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_BALANCE_ENTRY` |
| 2 | BALANCE_ENTRY_CTL | 20 | 10712 | 15 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_BALANCE_ENTRY_CTL` |

#### DG_393 — 2 members
- **Sources:** `CSR_ACCOUNT, CSR_CIRCUIT_LISTING, INVOICE, LINE_ITEM, LINE_ITEM_JUR_DTL +4 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_CKT_MRC | 20 | 10717 | 30 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_CKT_MRC` |
| 2 | CKT_MRC_CTL | 20 | 10718 | 30 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_CKT_MRC_CTL` |

#### DG_394 — 2 members
- **Sources:** `DISPUTE, DISPUTE_CATEGORY, INVOICE, RECONCILE_ACTION, SUPPLIER_INV_DETAIL +1 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DISPUTE_CAT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_DISPUTE_PAYBACK | 20 | 10726 | 16 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_DISPUTE_PAYBACK` |
| 2 | DISPUTE_PAYBACK_CTL | 20 | 10727 | 16 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_DISPUTE_PAYBACK_CTL` |

#### DG_395 — 2 members
- **Sources:** `ASG_OCL, CSR_ACCOUNT, CSR_ACCOUNT_1, CSR_ACCOUNT_2, CSR_CIRCUIT_LISTING +10 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_FACEPAGE_MRC | 20 | 10728 | 37 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_FACEPAGE_MRC` |
| 2 | FACEPAGE_MRC_CTL | 20 | 10729 | 37 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_FACEPAGE_MRC_CTL` |

#### DG_396 — 2 members
- **Sources:** `CDMTB_REVENUE_DETAIL_KENAN, CDMTB_REVENUE_DETAIL_RJF, DUMMY_NBR_SRC`
- **Targets:** `DUMMY_TGT, ETL_PARAMETER`
- **Lookups:** `ETL_PARAMETER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_KENAN_insert | 2 | 8002 | 9 | `s_m_Load_CDMTB_REVENUE_DETAIL_KENAN_insert` |
| 2 | DETAIL_LATAM_insert | 2 | 8003 | 9 | `s_m_Load_CDMTB_REVENUE_DETAIL_LATAM_insert` |

#### DG_397 — 2 members
- **Sources:** `INVOICE, OCC_ADJ_DTL, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL1`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_OCC_FACEPAGE | 20 | 10738 | 21 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_OCC_FACEPAGE` |
| 2 | OCC_FACEPAGE_CTL | 20 | 10739 | 21 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_OCC_FACEPAGE_CTL` |

#### DG_398 — 2 members
- **Sources:** `INVOICE, INVOICE1, SUPPLIER_INVOICE, SUPPLIER_INVOICE1, SUPPLIER_INV_DETAIL +2 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_REG_FACEPAGE | 20 | 10742 | 17 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_REG_FACEPAGE` |
| 2 | REG_FACEPAGE_CTL | 20 | 10743 | 17 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_REG_FACEPAGE_CTL` |

#### DG_399 — 2 members
- **Sources:** `INVOICE, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL1`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DETAIL_USAGE_FACEPAGE | 20 | 10758 | 17 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_USAGE_FACEPAGE` |
| 2 | USAGE_FACEPAGE_CTL | 20 | 10759 | 17 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_USAGE_FACEPAGE_CTL` |

#### DG_400 — 2 members
- **Sources:** `ORDER_DIR_LIST_FEATURES, ORDER_DIR_LIST_FEATURES1, ORDER_DIR_LIST_FEATURES2`
- **Targets:** `DRIVING_KEY1, FF_LOAD_STATUS, ORDER_DIR_LIST_FEATURES`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DIR_LIST_FEATURES | 1 | 3886 | 15 | `s_m_Load_ORDER_DIR_LIST_FEATURES` |
| 2 | LIST_FEATURES_hist | 1 | 3887 | 15 | `s_m_Load_ORDER_DIR_LIST_FEATURES_hist` |

#### DG_401 — 2 members
- **Sources:** `BILLING_PRODUCT_COMPNT_CRIS, BILLING_PRODUCT_COMPNT_CRIS1`
- **Targets:** `BILLING_PRODUCT_COMPNT_CRIS`
- **Lookups:** `CDW_CPROD10T_DLY, CRTS_B539_DSCNCT_RSN_TYPE, SOADT10V`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DISCONNECT_RSN_CRIS | 2 | 7978 | 13 | `s_m_Load_BILLING_PRODUCT_COMPNT_DISCONNECT_RSN_CRIS` |
| 2 | DISCONNECT_RSN_HISTORY | 2 | 7979 | 13 | `s_m_Load_BILLING_PRODUCT_COMPNT_DISCONNECT_RSN_HISTORY` |

#### DG_402 — 2 members
- **Sources:** `DISPUTE_DETAIL, SUPPLIER_INV_DISPUTE_CAT`
- **Targets:** `SUPPLIER_INV_DISPUTE_CAT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DISPUTE_CAT_SAM | 2 | 8149 | 11 | `s_m_Load_NETEX_SUPPLIER_INV_DISPUTE_CAT_SAM` |
| 2 | CAT_SAM_EMEA | 2 | 8150 | 11 | `s_m_Load_NETEX_SUPPLIER_INV_DISPUTE_CAT_SAM_EMEA` |

#### DG_403 — 2 members
- **Sources:** `CLAIM_COMMUNICATION, SUPPLIER_DISPUTE_INTRXN`
- **Targets:** `CODS_NETEX, SUPPLIER_DISPUTE_INTRXN`
- **Lookups:** `DISPUTE_DETAIL, SUPPLIER_DISPUTE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DISPUTE_INTRXN_SAM | 21 | 10831 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTE_INTRXN_SAM` |
| 2 | INTRXN_SAM_LATAM | 21 | 10833 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTE_INTRXN_SAM_LATAM` |

#### DG_404 — 2 members
- **Sources:** `CLAIM_WORKFLOW_HISTORY, SUPPLIER_DISPUTE_WF`
- **Targets:** `CODS_NETEX, SUPPLIER_DISPUTE_WF`
- **Lookups:** `DISPUTE_DETAIL, SUPPLIER_DISPUTE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DISPUTE_WF_SAM | 21 | 10834 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTE_WF_SAM` |
| 2 | WF_SAM_LATAM | 21 | 10836 | 10 | `s_m_Load_NETEX_SUPPLIER_DISPUTE_WF_SAM_LATAM` |

#### DG_405 — 2 members
- **Sources:** `AE2E_ENDSTATE_GRANITE_PREP, AE2E_ENDSTATE_GRANITE_PREP1, AE2E_ENDSTATE_GRANITE_PREP2, AE2E_ENDSTATE_GRANITE_PREP21, AE2E_JOB_LOG +4 more`
- **Targets:** `AE2E_JOB_LOG, AE2E_PIPELINE_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DIS_PPL_PREP | 3 | 8945 | 14 | `s_m_Load_UNITY_AE2E_CUS_DIS_PPL_PREP` |
| 2 | INS_PPL_PREP | 3 | 8947 | 14 | `s_m_Load_UNITY_AE2E_CUS_INS_PPL_PREP` |

#### DG_406 — 2 members
- **Sources:** `SUPP_INV_DTL_SURCHARGE, SURCHARGE_DETAIL`
- **Targets:** `SUPP_INV_DTL_SURCHARGE`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DTL_SURCHARGE_SAM | 24 | 11238 | 10 | `s_m_Load_NETEX_SUPP_INV_DTL_SURCHARGE_SAM` |
| 2 | SURCHARGE_SAM_EMEA | 24 | 11239 | 10 | `s_m_Load_NETEX_SUPP_INV_DTL_SURCHARGE_SAM_EMEA` |

#### DG_407 — 2 members
- **Sources:** `SUPP_INV_DTL_TAX, TAX_DETAIL`
- **Targets:** `SUPP_INV_DTL_TAX`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DTL_TAX_SAM | 24 | 11241 | 10 | `s_m_Load_NETEX_SUPP_INV_DTL_TAX_SAM` |
| 2 | TAX_SAM_EMEA | 24 | 11242 | 10 | `s_m_Load_NETEX_SUPP_INV_DTL_TAX_SAM_EMEA` |

#### DG_408 — 2 members
- **Sources:** `SUPP_INV_DTL_USAGE, USAGE_DETAIL`
- **Targets:** `CODS_NETEX, SUPP_INV_DTL_USAGE`
- **Lookups:** `SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DTL_USAGE_SAM | 24 | 11244 | 10 | `s_m_Load_NETEX_SUPP_INV_DTL_USAGE_SAM` |
| 2 | USAGE_SAM_LATAM | 24 | 11246 | 10 | `s_m_Load_NETEX_SUPP_INV_DTL_USAGE_SAM_LATAM` |

#### DG_409 — 2 members
- **Sources:** `SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL11`
- **Targets:** `SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_COST_CAT, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | DUE_DIFF_SAM | 20 | 10721 | 14 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_CURR_DUE_DIFF_SAM` |
| 2 | DIFF_SAM_EMEA | 20 | 10722 | 14 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_CURR_DUE_DIFF_SAM_EMEA` |

#### DG_410 — 2 members
- **Sources:** `PARAMETER_FILE_BASE`
- **Targets:** `PARAMETER_FILE_TGT`
- **Lookups:** `D_TAXMART_PERIOD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | E911_TAXES_BILLED | 12 | 9931 | 4 | `s_m_GENERATE_PARAMETER_FILE_E911_TAXES_BILLED` |
| 2 | EQUIPMENT_DETAIL_REPORT | 12 | 9932 | 4 | `s_m_GENERATE_PARAMETER_FILE_EQUIPMENT_DETAIL_REPORT` |

#### DG_411 — 2 members
- **Sources:** `ECCKT_SITE, ECCKT_SITE2, ECCKT_SITE3`
- **Targets:** `DSL_AML, ECCKT_SITE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ECCKT_SITE_EON | 1 | 7473 | 9 | `s_m_load_ECCKT_SITE_EON` |
| 2 | ECCKT_SITE_WILTEL | 1 | 7474 | 9 | `s_m_load_ECCKT_SITE_WILTEL` |

#### DG_412 — 2 members
- **Sources:** `ECCKT_SITE, ECCKT_SITE2, ECCKT_SITE3`
- **Targets:** `DSL_AML, ECCKT_SITE`
- **Lookups:** `CLLI_NODE_TYPE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ECCKT_SITE_LTID | 3 | 9014 | 11 | `s_m_load_ECCKT_SITE_LTID` |
| 2 | ECCKT_SITE_WF | 3 | 9015 | 11 | `s_m_load_ECCKT_SITE_WF` |

#### DG_413 — 2 members
- **Sources:** `ECCKT`
- **Targets:** `DSL_AML, ECCKT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ECCKT_SUPPLIER_BAN | 1 | 6953 | 2 | `s_m_Update_ECCKT_SUPPLIER_BAN` |
| 2 | COMPANY_NBR_ECCKT | 1 | 7668 | 3 | `s_m_update_DW_SECURE_COMPANY_NBR_ECCKT` |

#### DG_414 — 2 members
- **Sources:** `NC_ENDPOINT_DETAIL, TRAIL`
- **Targets:** `NC_ENDPOINT_DETAIL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ENDPOINT_DETAIL_EON | 3 | 8877 | 9 | `s_m_Load_NC_ENDPOINT_DETAIL_EON` |
| 2 | ENDPOINT_DETAIL_RSI | 3 | 8879 | 9 | `s_m_Load_NC_ENDPOINT_DETAIL_RSI` |

#### DG_415 — 2 members
- **Sources:** `STG_END_IN_SERVICE`
- **Targets:** `DSL_UNT_PRD_ACTY, F_END_IN_SERVICE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | END_IN_SERVICE | 1 | 658 | 2 | `s_m_Insert_F_END_IN_SERVICE` |
| 2 | END_IN_SERVICE | 17 | 10534 | 3 | `s_m_Update_F_END_IN_SERVICE` |

#### DG_416 — 2 members
- **Sources:** `SALES_ORDER_LINE_HIST, SALES_ORDER_LINE_STG, SALES_ORDER_LINE_STG1`
- **Targets:** `DSL_SALES_PERIOD, SALES_ORDER_LINE_STG`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, CUSTOMER, GL_MGMT_PRODUCT, PMO_PRESAR_DECOMP, SALES_ORDER_LINE_HIST`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | END_OF_MONTH | 33 | 12463 | 10 | `s_m_LOAD_PRESAR_STG_END_OF_MONTH` |
| 2 | STG_MID_MONTH | 33 | 12464 | 10 | `s_m_LOAD_PRESAR_STG_MID_MONTH` |

#### DG_417 — 2 members
- **Sources:** `BILLING_PRODUCT_COMPNT_CABS`
- **Targets:** `BILLING_PRODUCT_COMPNT, BILLING_PRODUCT_COMPNT_CABS, CODS_BILLING`
- **Lookups:** `PHYS_STRUCT_GEOCODE, PRODUCT_LOCATION, SOURCE_BILLING_ACCOUNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ENS_TN_Active | 11 | 9849 | 9 | `s_m_Load_BILLING_PRODUCT_COMPNT_ENS_TN_Active` |
| 2 | ENS_TN_Expired | 11 | 9850 | 9 | `s_m_Load_BILLING_PRODUCT_COMPNT_ENS_TN_Expired` |

#### DG_418 — 2 members
- **Sources:** `GL_MGMT_PRODUCT_XREF, GL_MGMT_PRODUCT_XREF_SUP`
- **Targets:** `CDW_COMMON, GL_MGMT_PRODUCT_XREF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ENS_UPD_FLATFILE | 1 | 3034 | 9 | `s_m_Load_GL_MGMT_PRODUCT_CD_ENS_UPD_FLATFILE` |
| 2 | PRODUCT_XREF_RSOR | 1 | 6980 | 9 | `s_m_Update_GL_MGMT_PRODUCT_XREF_RSOR` |

#### DG_419 — 2 members
- **Sources:** `EON_EQUIPMENT_STATUS`
- **Targets:** `EON, EON_EQUIPMENT_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | EON_EQUIPMENT_STATUS | 1 | 2580 | 3 | `s_m_Load_EON_EQUIPMENT_STATUS` |
| 2 | RING_WAVE_STG | 1 | 4749 | 2 | `s_m_Load_RING_WAVE_STG` |

#### DG_420 — 2 members
- **Sources:** `CKT_ORDER`
- **Targets:** `CKT_ORDER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | EWH_CKT_ORDER | 1 | 5216 | 2 | `s_m_Load_SRC_EWH_CKT_ORDER` |
| 2 | STG_CKT_ORDER | 1 | 5244 | 2 | `s_m_Load_SRC_STG_CKT_ORDER` |

#### DG_421 — 2 members
- **Sources:** `OPERATOR_DICT`
- **Targets:** `OPERATOR_DICT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | EWH_OPERATOR_DICT | 1 | 5224 | 2 | `s_m_Load_SRC_EWH_OPERATOR_DICT` |
| 2 | STG_OPERATOR_DICT | 1 | 5257 | 2 | `s_m_Load_SRC_STG_OPERATOR_DICT` |

#### DG_422 — 2 members
- **Sources:** `ACCRUAL_CHARGE, ACCRUAL_CHARGE_MJE_EXPORT_SAP`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, DSL_AIM`
- **Lookups:** `GL_ACCOUNT, GL_COMPANY`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | EXPORT_OCC_SAP | 23 | 11107 | 9 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_OCC_SAP` |
| 2 | OCC_SAP_CTL | 23 | 11108 | 9 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_OCC_SAP_CTL` |

#### DG_423 — 2 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, ACCRUAL_CHARGE_MJE_EXPORT_SAP1, DSL_AIM`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP_FF, ACCRUAL_CHARGE_MJE_EXPORT_SAP_LATAM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | EXPORT_SAP_FF | 31 | 12274 | 10 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_FF` |
| 2 | SAP_FF_CTL | 31 | 12275 | 9 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP_FF_CTL` |

#### DG_424 — 2 members
- **Sources:** `PROCESS_PARAMETER, PROCESS_PARAMETER1`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FBE_GCTL_ALL | 16 | 10396 | 7 | `s_m_Load_RECON_GLB_FBE_GCTL_ALL` |
| 2 | PROF_PRE_ALLOC | 16 | 10450 | 4 | `s_m_Swap_Partitions_for_PROD_PROF_PRE_ALLOC` |

#### DG_425 — 2 members
- **Sources:** `E_INVOICE_FINAL, E_INVOICE_FINAL1, E_INVOICE_FINAL2, E_INVOICE_FINAL3, F_GAAP_REVENUE +1 more`
- **Targets:** `FL_GENERATED_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FBR_RECON_REPORT | 25 | 11364 | 13 | `s_m_GENERATE_PARAMETERS_FBR_RECON_REPORT` |
| 2 | RECON_REPORT_TAXMART | 25 | 11365 | 13 | `s_m_GENERATE_PARAMETERS_FBR_RECON_REPORT_TAXMART` |

#### DG_426 — 2 members
- **Sources:** `DUMMY_NBR_SRC, TMP_FRD_AMT_ARADJLA, TMP_FRD_AMT_ARTLDA`
- **Targets:** `FF_DUMMY, FF_LOAD_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FRD_AMT_ARADJLA | 1 | 6105 | 6 | `s_m_Load_TMP_FRD_AMT_ARADJLA` |
| 2 | GL_BALANCE_ID | 1 | 6137 | 6 | `s_m_Load_TMP_SAP_GL_BALANCE_ID` |

#### DG_427 — 2 members
- **Sources:** `CDMTB_REVENUE_DETAIL_CABS, JOURNAL_HEADER, JOURNAL_LINE`
- **Targets:** `STG_F_REVENUE_DETAIL, STG_F_REVENUE_DETAIL_AMT`
- **Lookups:** `CALENDAR, DH_GL_ACCOUNT, DH_GL_BUSINESS_AREA, DH_GL_COMPANY, DH_GL_COST_CENTER +12 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FRD_AMT_ENS | 15 | 10248 | 23 | `s_m_Load_STG_FRD_STG_FRD_AMT_ENS` |
| 2 | AMT_ENS_Resource | 15 | 10249 | 26 | `s_m_Load_STG_FRD_STG_FRD_AMT_ENS_Resource` |

#### DG_428 — 2 members
- **Sources:** `CDMTB_REVENUE_DETAIL_KENAN, JOURNAL_HEADER, JOURNAL_LINE`
- **Targets:** `STG_F_REVENUE_DETAIL_AMT, STG_F_REVENUE_DETAIL_SRC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FRD_AMT_KENAN | 15 | 10244 | 6 | `s_m_Load_STG_FRD_SRC_STG_FRD_AMT_KENAN` |
| 2 | AMT_KENAN_Resource | 15 | 10245 | 8 | `s_m_Load_STG_FRD_SRC_STG_FRD_AMT_KENAN_Resource` |

#### DG_429 — 2 members
- **Sources:** `CDMTB_REVENUE_DETAIL_CABS, CDMTB_REVENUE_DETAIL_RJF, JOURNAL_HEADER, JOURNAL_LINE`
- **Targets:** `STG_F_REVENUE_DETAIL, STG_F_REVENUE_DETAIL_AMT`
- **Lookups:** `CALENDAR, CRTS_B582_BAC_RVN_MAP, DH_GL_ACCOUNT, DH_GL_BUSINESS_AREA, DH_GL_COMPANY +18 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | FRD_AMT_MBS | 15 | 10250 | 33 | `s_m_Load_STG_FRD_STG_FRD_AMT_MBS` |
| 2 | FRD_AMT_RJF | 15 | 10254 | 33 | `s_m_Load_STG_FRD_STG_FRD_AMT_RJF` |

#### DG_430 — 2 members
- **Sources:** `D_TAXMART_PERIOD, F_BILLING_ROLLUP, F_BILLING_ROLLUP_NON_INT_MAX, F_BILLING_ROLLUP_NON_INT_MIN`
- **Targets:** `FL_GENERATED_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | F_MOU_CDC | 16 | 10275 | 8 | `s_m_GENERATE_PARAMETERS_F_MOU_CDC` |
| 2 | MOU_CDC_TAXMART | 16 | 10276 | 8 | `s_m_GENERATE_PARAMETERS_F_MOU_CDC_TAXMART` |

#### DG_431 — 2 members
- **Sources:** `E_INVOICE_ROW_DETAIL, E_INVOICE_ROW_DETAIL_NON_INT, F_BILLING_ROLLUP, F_BILLING_ROLLUP_NON_INT`
- **Targets:** `F_MOU`
- **Lookups:** `F_BILLING_ROLLUP, F_MOU, SERVICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | F_MOU_CDC | 25 | 11368 | 27 | `s_m_LOAD_F_MOU_CDC` |
| 2 | MOU_CDC_TAXMART | 25 | 11369 | 27 | `s_m_LOAD_F_MOU_CDC_TAXMART` |

#### DG_432 — 2 members
- **Sources:** `TEMP_CALL_DETAIL_PROCESS`
- **Targets:** `CALL_DETAIL_PROCESS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | From_TCDP_Stage2 | 2 | 8005 | 11 | `s_m_Load_CDP_From_TCDP_Stage2` |
| 2 | From_TCDP_Stg2 | 2 | 8007 | 11 | `s_m_Load_CDP_From_TCDP_Stg2` |

#### DG_433 — 2 members
- **Sources:** `PHYS_STRUCT_GEOCODE`
- **Targets:** `MAR_WEB`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GEOCODE_WEB_MARS | 30 | 12141 | 2 | `s_m_Load_PHYS_STRUCT_GEOCODE_WEB_MARS` |
| 2 | WEB_MARS_HIST | 30 | 12142 | 2 | `s_m_Load_PHYS_STRUCT_GEOCODE_WEB_MARS_HIST` |

#### DG_434 — 2 members
- **Sources:** `FF_LOAD_STATUS`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GIS_CALL_TIMESTAMP | 30 | 12126 | 4 | `s_m_Load_FTP_GIS_CALL_TIMESTAMP` |
| 2 | PROD_PROF_DUMMY | 30 | 12150 | 2 | `s_m_Load_PROD_PROF_DUMMY` |

#### DG_435 — 2 members
- **Sources:** `F_REVENUE_DETAIL_ALL`
- **Targets:** `SWP_DH_LEGACY_GL_MASTER_XREF`
- **Lookups:** `BILLING_ACCOUNT, CRTS_B591, GL_CUSTOMER_SEGMENT, GL_PERIOD, GL_SEG2_PROFIT_CTR +3 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GL_MASTER_XREF | 24 | 11220 | 24 | `s_m_Load_DH_LEGACY_GL_MASTER_XREF` |
| 2 | XREF_NEXT_MNTH | 24 | 11221 | 24 | `s_m_Load_DH_LEGACY_GL_MASTER_XREF_NEXT_MNTH` |

#### DG_436 — 2 members
- **Sources:** `ALLOCATION_DETAIL, SUPPLIER_INV_GL_SAM`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_GL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, USOC_BILLED`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GL_SAM_LATAM | 21 | 10842 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_GL_SAM_LATAM` |
| 2 | GL_SAM_Weekly | 21 | 10843 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_GL_SAM_Weekly` |

#### DG_437 — 2 members
- **Sources:** `FF_CISCO_DNA, FF_GM_DNA`
- **Targets:** `FF_CISCO_DNA_RET_CD`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GM_Report_DNA | 1 | 629 | 5 | `s_m_GM_Report_DNA` |
| 2 | ZOOM_Report_DNA | 1 | 7059 | 5 | `s_m_ZOOM_Report_DNA` |

#### DG_438 — 2 members
- **Sources:** `BILLING_ACCOUNT, TN_INVENTORY`
- **Targets:** `TN_INVENTORY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GNAS_TN_INVENTORY | 24 | 11302 | 9 | `s_m_Update_LEXM_GNAS_TN_INVENTORY` |
| 2 | LD_TN_INVENTORY | 24 | 11303 | 9 | `s_m_Update_LEXM_LD_TN_INVENTORY` |

#### DG_439 — 2 members
- **Sources:** `DUMMY_TEST`
- **Targets:** `SWP_GOAT_DATA_ESSBASE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | GOAT_DATA_ESSBASE | 1 | 3049 | 6 | `s_m_Load_GOAT_DATA_ESSBASE` |
| 2 | GOAT_DATA_ESSBASE | 1 | 5612 | 6 | `s_m_Load_SWP_GOAT_DATA_ESSBASE` |

#### DG_440 — 2 members
- **Sources:** `D_TAXMART_PERIOD`
- **Targets:** `FL_GENERATE_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Generate_Parameters_CDC | 12 | 9934 | 4 | `s_m_Generate_Parameters_CDC` |
| 2 | Parameters_CDC_FBR | 12 | 9935 | 4 | `s_m_Generate_Parameters_CDC_FBR` |

#### DG_441 — 2 members
- **Sources:** `DUAL`
- **Targets:** `EMPTY_PARM_FF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Generate_ReRollup_Date | 30 | 12085 | 2 | `s_m_Generate_ReRollup_Date` |
| 2 | Generate_Rollup_Date | 30 | 12086 | 2 | `s_m_Generate_Rollup_Date` |

#### DG_442 — 2 members
- **Sources:** `D_CLNDR`
- **Targets:** `M_PROCESS_CONTROL_USR`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Generate_Report_Parameter | 2 | 7839 | 2 | `s_m_Generate_Report_Parameter` |
| 2 | Report_Parameter_Manual | 2 | 7840 | 2 | `s_m_Generate_Report_Parameter_Manual` |

#### DG_443 — 2 members
- **Sources:** `PHYSICAL_PORT`
- **Targets:** `CODS_NETINV, PHYSICAL_PORT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | HARD_DELETE_EQUIPMENT | 1 | 3067 | 1 | `s_m_Load_HARD_DELETE_EQUIPMENT` |
| 2 | DELETE_PHYSICAL_PORT | 1 | 3068 | 1 | `s_m_Load_HARD_DELETE_PHYSICAL_PORT` |

#### DG_444 — 2 members
- **Sources:** `AE2E_BTP_STG3, AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG`
- **Targets:** `AE2E_BILL_TAMER_PREP, AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG`
- **Lookups:** `AE2E_SYSTEM`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | HIST_BTP_PREP | 24 | 11195 | 7 | `s_m_LOAD_AE2E_BW_HIST_BTP_PREP` |
| 2 | VYVX_BTP_PREP | 24 | 11196 | 7 | `s_m_LOAD_AE2E_VYVX_BTP_PREP` |

#### DG_445 — 2 members
- **Sources:** `CDRW_PARTITION_VALUES`
- **Targets:** `FF_CDRW_CD_HIST_PARAMTER, FF_CDRW_PARTITION_VALUES`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | HIST_CDD_Partition | 1 | 633 | 2 | `s_m_Generate_CDRW_HIST_CDD_Partition` |
| 2 | HIST_CD_Partition | 1 | 634 | 2 | `s_m_Generate_CDRW_HIST_CD_Partition` |

#### DG_446 — 2 members
- **Sources:** `EQUIPMENT_HOLDER, EQUIPMENT_HOLDER1, SLOT`
- **Targets:** `CODS_NETINV, EQUIPMENT_HOLDER`
- **Lookups:** `EQUIPMENT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | HOLDER_AMDOCS_RM | 8 | 9542 | 10 | `s_m_Load_EQUIPMENT_HOLDER_AMDOCS_RM` |
| 2 | EQUIPMENT_HOLDER_TIRKS | 8 | 9547 | 10 | `s_m_Load_EQUIPMENT_HOLDER_TIRKS` |

#### DG_447 — 2 members
- **Sources:** `EQUIPMENT_IN_HOLDER, PORT`
- **Targets:** `CODS_NETINV, EQUIPMENT_IN_HOLDER`
- **Lookups:** `EQUIPMENT, EQUIPMENT_HOLDER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | HOLDER_AMDOCS_RM | 9 | 9658 | 10 | `s_m_Load_EQUIPMENT_IN_HOLDER_AMDOCS_RM` |
| 2 | IN_HOLDER_TIRKS | 9 | 9663 | 10 | `s_m_Load_EQUIPMENT_IN_HOLDER_TIRKS` |

#### DG_448 — 2 members
- **Sources:** `ASL_LOAD_STATUS, CDMTB_KEY, DUMMY_LAST_EXTRACT, DUMMY_TMP, EPWF_KEY +2 more`
- **Targets:** `DUMMY_TGT, FF_LOAD_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ID_TEMP_CRIS | 5 | 9301 | 12 | `s_m_Load_RECON_CASH_RECEIPT_KEY_ID_TEMP_CRIS` |
| 2 | ID_TEMP_ENS | 5 | 9302 | 12 | `s_m_Load_RECON_CASH_RECEIPT_KEY_ID_TEMP_ENS` |

#### DG_449 — 2 members
- **Sources:** `CDW_LOAD_RULE, CONTACT, CUSTOMER, SOURCE_CONTACT, SOURCE_CONTACT1`
- **Targets:** `CODS, SOURCE_CONTACT`
- **Lookups:** `EMPLOYEE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | IFO_SOURCE_CONTACT | 9 | 9670 | 23 | `s_m_Load_IFO_SOURCE_CONTACT` |
| 2 | QMV_SOURCE_CONTACT | 9 | 9699 | 23 | `s_m_Load_QMV_SOURCE_CONTACT` |

#### DG_450 — 2 members
- **Sources:** `WILTEL_OFFNET_MGR_INVENTORY, WILTEL_OFFNET_MGR_INVENTORY2`
- **Targets:** `WILTEL_OFFNET_MGR_INVENTORY`
- **Lookups:** `WILTEL_OFFNET_MGR_INVENTORY`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INSTALL_PON_ONM | 1 | 686 | 3 | `s_m_LOAD_AE2E_POPULATE_INSTALL_PON_ONM` |
| 2 | CMPLT_PON_ONM | 1 | 687 | 3 | `s_m_LOAD_AE2E_POPULATE_LAST_CMPLT_PON_ONM` |

#### DG_451 — 2 members
- **Sources:** `INTERNAL_STATE_HIST, INTERNAL_STATE_HIST11, INTERNAL_STATE_HIST2`
- **Targets:** `DRIVING_KEY1, FF_LOAD_STATUS, INTERNAL_STATE_HIST`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INTERNAL_STATE_HIST | 1 | 3124 | 15 | `s_m_Load_INTERNAL_STATE_HIST` |
| 2 | STATE_HIST_hist | 1 | 3125 | 15 | `s_m_Load_INTERNAL_STATE_HIST_hist` |

#### DG_452 — 2 members
- **Sources:** `INVOICE, INVOICE_LATAM_DOCUMENT_TYPE, REGULATORY_INVOICE, REGULATORY_INVOICE1, SEQ_INV_NO_EXT`
- **Targets:** `FF_LOAD_STATUS, REGULATORY_INVOICE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INVOICE_IDC_KENAN | 15 | 10227 | 15 | `s_m_Load_REGULATORY_INVOICE_IDC_KENAN` |
| 2 | REGULATORY_INVOICE_KENANFX | 15 | 10228 | 15 | `s_m_Load_REGULATORY_INVOICE_KENANFX` |

#### DG_453 — 2 members
- **Sources:** `INVOICE_ITEM, STG_INVOICE_ITEM, STG_INVOICE_ITEM1`
- **Targets:** `INVOICE_ITEM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INVOICE_ITEM_IDC | 1 | 3137 | 9 | `s_m_Load_INVOICE_ITEM_IDC` |
| 2 | INVOICE_ITEM_KENANFX | 1 | 3138 | 9 | `s_m_Load_INVOICE_ITEM_KENANFX` |

#### DG_454 — 2 members
- **Sources:** `INV_NOTES, SUPPLIER_INVOICE_NOTE`
- **Targets:** `CODS_NETEX, SUPPLIER_INVOICE_NOTE`
- **Lookups:** `SUPPLIER_INVOICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INVOICE_NOTE_SAM | 20 | 10694 | 10 | `s_m_Load_NETEX_SUPPLIER_INVOICE_NOTE_SAM` |
| 2 | NOTE_SAM_LATAM | 20 | 10696 | 10 | `s_m_Load_NETEX_SUPPLIER_INVOICE_NOTE_SAM_LATAM` |

#### DG_455 — 2 members
- **Sources:** `SUPPLIER_INVOICE_WF`
- **Targets:** `CODS_NETEX, SUPPLIER_INVOICE_WF`
- **Lookups:** `SUPPLIER_INVOICE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INVOICE_WF_SAM | 20 | 10697 | 10 | `s_m_Load_NETEX_SUPPLIER_INVOICE_WF_SAM` |
| 2 | WF_SAM_LATAM | 20 | 10699 | 10 | `s_m_Load_NETEX_SUPPLIER_INVOICE_WF_SAM_LATAM` |

#### DG_456 — 2 members
- **Sources:** `DISPUTE, DISPUTE_CATEGORY, DISPUTE_INVOICE, INVOICE, SUPPLIER_INV_DETAIL +1 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DISPUTE_CAT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_DETAIL_DISPUTE | 20 | 10724 | 16 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_DISPUTE` |
| 2 | DETAIL_DISPUTE_CTL | 20 | 10725 | 16 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_DISPUTE_CTL` |

#### DG_457 — 2 members
- **Sources:** `INVOICE, OCC_ADJ_CIRCUIT_DTL, OCC_ADJ_DTL, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL +1 more`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_CIRCUIT, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_DETAIL_OCC | 20 | 10736 | 23 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_OCC` |
| 2 | DETAIL_OCC_CTL | 20 | 10737 | 23 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_OCC_CTL` |

#### DG_458 — 2 members
- **Sources:** `SUPPLIER_CIRCUIT, SUPPLIER_INV_DETAIL`
- **Targets:** `CODS_NETEX, SUPPLIER_CKT_INV_DETAIL_TMP, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL_TMP, USOC_BILLED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_DETAIL_Phase1 | 22 | 11074 | 7 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase1` |
| 2 | DETAIL_Phase1_CTL | 22 | 11075 | 7 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase1_CTL` |

#### DG_459 — 2 members
- **Sources:** `SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL2`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL_TMP, USOC_BILLED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_DETAIL_Phase2 | 1 | 6873 | 5 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase2` |
| 2 | DETAIL_Phase2_CTL | 1 | 6874 | 5 | `s_m_Upd_NETEX_SUPPLIER_INV_DETAIL_Phase2_CTL` |

#### DG_460 — 2 members
- **Sources:** `INVOICE, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL1, USAGE_SUMMARY`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_DETAIL_USAGE | 20 | 10756 | 19 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_USAGE` |
| 2 | DETAIL_USAGE_CTL | 20 | 10757 | 19 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_USAGE_CTL` |

#### DG_461 — 2 members
- **Sources:** `DISPUTE_CATEGORY, SUPPLIER_INV_DISPUTE_CAT, SUPPLIER_INV_DISPUTE_CAT1`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DISPUTE_CAT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_DISPUTE_CAT | 2 | 8147 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_DISPUTE_CAT` |
| 2 | DISPUTE_CAT_CTL | 2 | 8148 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_DISPUTE_CAT_CTL` |

#### DG_462 — 2 members
- **Sources:** `EXCEPTION_LOG, SUPPLIER_INV_EXCEPTION`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_EXCEPTION`
- **Lookups:** `SUPPLIER_INVOICE, SUPP_INV_AUDIT_DEF`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_EXCEPTION_SAM | 20 | 10763 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_EXCEPTION_SAM` |
| 2 | EXCEPTION_SAM_LATAM | 20 | 10765 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_EXCEPTION_SAM_LATAM` |

#### DG_463 — 2 members
- **Sources:** `ALLOCATION_DETAIL, SUPPLIER_INV_GL_SAM, SUPPLIER_INV_GL_SAM1`
- **Targets:** `SUPPLIER_INV_GL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, USOC_BILLED`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | INV_GL_SAM | 21 | 10839 | 17 | `s_m_Load_NETEX_SUPPLIER_INV_GL_SAM` |
| 2 | GL_SAM_EMEA | 21 | 10840 | 17 | `s_m_Load_NETEX_SUPPLIER_INV_GL_SAM_EMEA` |

#### DG_464 — 2 members
- **Sources:** `LKP_ISOURCE_VENDOR_CODS, LKP_ISOURCE_VENDOR_CODS3`
- **Targets:** `ISOURCE, LKP_ISOURCE_VENDOR_CODS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ISOURCE_VENDER_CODS | 1 | 656 | 3 | `s_m_Initial_Load_LKP_ISOURCE_VENDER_CODS` |
| 2 | ISOURCE_VENDER_CODS1 | 1 | 657 | 3 | `s_m_Initial_Load_LKP_ISOURCE_VENDER_CODS1` |

#### DG_465 — 2 members
- **Sources:** `BILL_INVOICE, INVOICE, INVOICE1`
- **Targets:** `CDW_COMMON, REJECTED_ROW_LATAM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ITEM_KENAN_LATAM | 15 | 10233 | 8 | `s_m_Load_REJECTED_ROW_FOR_INVOICE_ITEM_KENAN_LATAM` |
| 2 | TAX_KENAN_LATAM | 15 | 10236 | 8 | `s_m_Load_REJECTED_ROW_FOR_INVOICE_ITEM_TAX_KENAN_LATAM` |

#### DG_466 — 2 members
- **Sources:** `BILL_INVOICE, BILL_INVOICE_DETAIL, BILL_INVOICE_TAX, RATE_CURRENCY_VALUES, TAX_PKG_INST_ID_VALUES`
- **Targets:** `FF_LOAD_STATUS, STG_INVOICE_ITEM_TAX`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, TAX_CODES_COMM, TAX_TYPE_COMM_VALUES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ITEM_TAX_IDC | 11 | 9900 | 4 | `s_m_Load_STG_INVOICE_ITEM_TAX_IDC` |
| 2 | ITEM_TAX_KENANFX | 11 | 9901 | 4 | `s_m_Load_STG_INVOICE_ITEM_TAX_KENANFX` |

#### DG_467 — 2 members
- **Sources:** `JOB_STATUS_LOG`
- **Targets:** `LIST_OF_MISSING_INTERVALS_RECOVERY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Interval_List_Green | 4 | 9039 | 2 | `s_m_Create_Missing_Interval_List_Green` |
| 2 | Interval_List_Red | 4 | 9040 | 2 | `s_m_Create_Missing_Interval_List_Red` |

#### DG_468 — 2 members
- **Sources:** `AP_TRXN_LINE_DIST_JL, AP_TRXN_LINE_DIST_JL_AMT, STG_AP_TRXN_LINE_DIST_JL_AMT, STG_AP_TRXN_LINE_DIST_JL_AMT1`
- **Targets:** `AP_TRXN_LINE_DIST_JL_AMT, FF_DEFAULT_RECORDS, FF_LOAD_STATUS, REJECTED_ROW, STG_AP_TRXN_LINE_DIST_JL_AMT`
- **Lookups:** `CURRENCY_EXCHANGE_RATE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | JL_AMT_DAILY | 14 | 10103 | 26 | `s_m_Load_AP_TRN_LN_DIST_JL_AMT_DAILY` |
| 2 | JL_AMT_DAILY | 14 | 10105 | 26 | `s_m_Load_AP_TRXN_LINE_DIST_JL_AMT_DAILY` |

#### DG_469 — 2 members
- **Sources:** `CAIMS_JOURNAL_N_TAXES_HIST_V, CAIMS_JOURNAL_N_TAXES_HIST_V1`
- **Targets:** `FF_LOAD_STATUS, LEGACY_CTL_BILLING_STG, TAXMART_STG`
- **Lookups:** `D_TAXMART_PERIOD, TAX_GEOCODES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | JOURNAL_TAXES_V | 12 | 9961 | 7 | `s_m_Load_CABS_CAIMS_JOURNAL_TAXES_V` |
| 2 | TAXES_HIST_V | 12 | 9962 | 7 | `s_m_Load_CAIMS_JOURNAL_N_TAXES_HIST_V` |

#### DG_470 — 2 members
- **Sources:** `BILLING_ACCOUNT, BILLING_ACCOUNT1, CMF, COUNTRY_CODE_VALUES, CUSTOMER_ID_ACCT_MAP +1 more`
- **Targets:** `BILLING_ACCOUNT`
- **Lookups:** `CUSTOMER, HZ_CUST_ACCOUNTS`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | KENAN_BILLING_ACCOUNT | 9 | 9632 | 10 | `s_m_Load_ADC_KENAN_BILLING_ACCOUNT` |
| 2 | KENAN_BILLING_ACCOUNT | 11 | 9854 | 10 | `s_m_Load_CDC_KENAN_BILLING_ACCOUNT` |

#### DG_471 — 2 members
- **Sources:** `REGJRN, REGJRN1`
- **Targets:** `ISL2, REGJRN, REGJRN1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | KENAN_CTQ_REGJRN | 1 | 3230 | 2 | `s_m_Load_KENAN_CTQ_REGJRN` |
| 2 | CTQ_REGJRN_HIST | 1 | 3231 | 2 | `s_m_Load_KENAN_CTQ_REGJRN_HIST` |

#### DG_472 — 2 members
- **Sources:** `REGJTX`
- **Targets:** `ISL2, REGJTX, REGJTX1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | KENAN_CTQ_REGJTX | 1 | 3232 | 2 | `s_m_Load_KENAN_CTQ_REGJTX` |
| 2 | CTQ_REGJTX_HIST | 1 | 3233 | 2 | `s_m_Load_KENAN_CTQ_REGJTX_HIST` |

#### DG_473 — 2 members
- **Sources:** `BILLING_PRODUCT_COMPNT`
- **Targets:** `BILLING_PRODUCT_COMPNT, CODS_BILLING`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | KENAN_ONE_TIME | 1 | 6889 | 3 | `s_m_Update_BILLING_PRODUCT_COMPNT_IDC_KENAN_ONE_TIME` |
| 2 | KENANFX_ONE_TIME | 1 | 7631 | 3 | `s_m_update_BILLING_PRODUCT_COMPNT_KENANFX_ONE_TIME` |

#### DG_474 — 2 members
- **Sources:** `BILLING_ACCOUNT, S_ADDR_PER`
- **Targets:** `BILLING_ACCOUNT`
- **Lookups:** `CUSTOMER, S_ORG_EXT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LATAM_BILLING_ACCOUNT | 21 | 10904 | 9 | `s_m_Load_SIEBEL6_LATAM_BILLING_ACCOUNT` |
| 2 | LATAM_BILLING_ACCOUNT | 21 | 10905 | 9 | `s_m_Load_SIEBEL8_LATAM_BILLING_ACCOUNT` |

#### DG_475 — 2 members
- **Sources:** `LPC_DETAIL, SUPP_INV_DTL_LATE_CHG`
- **Targets:** `SUPP_INV_DTL_LATE_CHG`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LATE_CHG_SAM | 24 | 11234 | 10 | `s_m_Load_NETEX_SUPP_INV_DTL_LATE_CHG_SAM` |
| 2 | CHG_SAM_EMEA | 24 | 11235 | 10 | `s_m_Load_NETEX_SUPP_INV_DTL_LATE_CHG_SAM_EMEA` |

#### DG_476 — 2 members
- **Sources:** `LEGACY_CTL_BILLING_STG, TAX_EVENT, TAX_EVENT_TRANS`
- **Targets:** `FF_LOAD_STATUS, LEGACY_CTL_BILLING_STG, TAXMART_STG`
- **Lookups:** `D_TAXMART_PERIOD, TAX_GEOCODES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LATIS_TAX_EVENT | 12 | 10004 | 7 | `s_m_Load_LATIS_TAX_EVENT` |
| 2 | TAX_EVENT_LATIS | 12 | 10033 | 7 | `s_m_Load_TAX_EVENT_LATIS` |

#### DG_477 — 2 members
- **Sources:** `PHYS_STRUCT_BUILDING`
- **Targets:** `GFS_LAT_LONG_LKP, WFMIMP1`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LAT_LONG_LKP | 30 | 12127 | 5 | `s_m_Load_GFS_LAT_LONG_LKP` |
| 2 | LKP_Initial_Load | 30 | 12128 | 4 | `s_m_Load_GFS_LAT_LONG_LKP_Initial_Load` |

#### DG_478 — 2 members
- **Sources:** `E_INVOICE_FINAL, E_INVOICE_ROW_DTL_NON_INTGRTD`
- **Targets:** `FL_GENERATED_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LINE_COUNT_CDC | 26 | 11477 | 4 | `s_m_GENERATE_PARAMETERS_F_JURSDCTN_REPORT_LINE_COUNT_CDC` |
| 2 | COUNT_CDC_TAXMART | 26 | 11478 | 4 | `s_m_GENERATE_PARAMETERS_F_JURSDCTN_REPORT_LINE_COUNT_CDC_TAXMART` |

#### DG_479 — 2 members
- **Sources:** `PO_TN_RANGE, TN_LINE_ORDER`
- **Targets:** `CODS_TN_STG, STG_TN_LINE_ORDER`
- **Lookups:** `EWFM_ORDER, EWFM_ORDER_SEGMENTS, GL_SEG2_PROFIT_CTR, ORDER_NUMBER, PHYS_STRUCT_GEOCODE +6 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LINE_ORDER_STG | 10 | 9778 | 1 | `s_m_Load_CPO_TN_LINE_ORDER_STG` |
| 2 | ORDER_STG_GCR0162855 | 10 | 9779 | 1 | `s_m_Load_CPO_TN_LINE_ORDER_STG_GCR0162855` |

#### DG_480 — 2 members
- **Sources:** `LINK_CONNECTION, LINK_CONNECTION1`
- **Targets:** `LINK_CONNECTION`
- **Lookups:** `TRAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LINK_CONNECTION_TARGET | 3 | 8867 | 11 | `s_m_Load_LINK_CONNECTION_TARGET` |
| 2 | CONNECTION_TARGET_INITIAL | 3 | 8868 | 12 | `s_m_Load_LINK_CONNECTION_TARGET_INITIAL` |

#### DG_481 — 2 members
- **Sources:** `CDW_BPC_INCR_BAN_LIST, ENS`
- **Targets:** `CDW_BPC_INCR_BAN_LIST, CDW_BPC_INCR_BAN_LIST_PRD, INFA_RO`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LIST_ENS_HISTORY | 9 | 9645 | 2 | `s_m_Load_CDW_BPC_INCR_BAN_LIST_ENS_HISTORY` |
| 2 | BAN_LIST_ENS | 9 | 9646 | 2 | `s_m_Load_CDW_BPC_REPROCESS_BAN_LIST_ENS` |

#### DG_482 — 2 members
- **Sources:** `CMF_EXEMPT`
- **Targets:** `CMF_EXEMPT`
- **Lookups:** `COUNTRY_CODE_VALUES, TAX_PKG_INST_ID_VALUES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | LOAD_CMF_EXEMPT | 2 | 7899 | 5 | `s_m_LOAD_CMF_EXEMPT` |
| 2 | CDC_CMF_EXEMPT | 2 | 7995 | 4 | `s_m_Load_CDC_CMF_EXEMPT` |

#### DG_483 — 2 members
- **Sources:** `FILELIST, FILELIST_D_SOURCE, FILELIST_L_SOURCE`
- **Targets:** `FILELIST_TARGET`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | L_Lookup_Files | 1 | 584 | 4 | `s_m_Create_D_L_Lookup_Files` |
| 2 | Lookup_Recosted_Files | 1 | 585 | 4 | `s_m_Create_D_L_Lookup_Recosted_Files` |

#### DG_484 — 2 members
- **Sources:** `CIRCUITTRACE, CIRCUIT_TRACE`
- **Targets:** `ASLNTFLX, CIRCUITTRACE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_CIRCUIT_TRACE2 | 1 | 1588 | 10 | `s_m_Load_CIRCUIT_TRACE2` |
| 2 | CIRCUIT_TRACE_NOKIA1830 | 1 | 1590 | 10 | `s_m_Load_CIRCUIT_TRACE_NOKIA1830` |

#### DG_485 — 2 members
- **Sources:** `PRASSIGNMENT, SRC_PRASSIGNMENT`
- **Targets:** `CLARITY, PRASSIGNMENT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_Clarity_PRASSIGNMENT | 1 | 1977 | 2 | `s_m_Load_Clarity_PRASSIGNMENT` |
| 2 | Clarity_PRASSIGNMENT_old | 1 | 1978 | 2 | `s_m_Load_Clarity_PRASSIGNMENT_old` |

#### DG_486 — 2 members
- **Sources:** `DACSPORT`
- **Targets:** `CODS_NETINV_STG, STG_TLC_DACPORT_SONETPORT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_DACPORT_TLC | 1 | 1984 | 2 | `s_m_Load_DACPORT_TLC` |
| 2 | Load_SONETPORT_TLC | 1 | 5164 | 2 | `s_m_Load_SONETPORT_TLC` |

#### DG_487 — 2 members
- **Sources:** `DOC_CHAN, DOC_CHAN1`
- **Targets:** `CRPL_NETFLEX, DOC_CHAN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_DOCCHAN_SRVR1 | 1 | 2103 | 2 | `s_m_Load_DOCCHAN_SRVR1` |
| 2 | load_DOCCHAN | 1 | 7470 | 2 | `s_m_load_DOCCHAN` |

#### DG_488 — 2 members
- **Sources:** `CUSTOMER`
- **Targets:** `CUSTOMER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_FOC_CUSTOMER | 1 | 2908 | 2 | `s_m_Load_FOC_CUSTOMER` |
| 2 | Update_ODS_CUSTOMER | 1 | 6987 | 2 | `s_m_Update_ODS_CUSTOMER` |

#### DG_489 — 2 members
- **Sources:** `INVOICE, STG_INVOICE, STG_INVOICE1`
- **Targets:** `INVOICE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_INVOICE_IDC | 1 | 3135 | 10 | `s_m_Load_INVOICE_IDC` |
| 2 | Load_INVOICE_KENANFX | 1 | 3140 | 10 | `s_m_Load_INVOICE_KENANFX` |

#### DG_490 — 2 members
- **Sources:** `MLSN, STG_MLSN`
- **Targets:** `ASLNTFLX, MLSN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_MLSN2 | 2 | 8132 | 10 | `s_m_Load_MLSN2` |
| 2 | TO_MLSN_DAILY | 2 | 8166 | 10 | `s_m_Load_NETFLEX_STG_TO_MLSN_DAILY` |

#### DG_491 — 2 members
- **Sources:** `SUPPLIER, SUPPLIER1, VENDOR`
- **Targets:** `SUPPLIER`
- **Lookups:** `AP_VENDOR, NETEX_HIERARCHY, ULTIMATE_CUSTOMER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_NETEX_SUPPLIER | 9 | 9681 | 10 | `s_m_Load_NETEX_SUPPLIER` |
| 2 | NETEX_SUPPLIER_CTL | 9 | 9682 | 10 | `s_m_Load_NETEX_SUPPLIER_CTL` |

#### DG_492 — 2 members
- **Sources:** `DUMMY_SRC, OSRP, OSRP_TGT`
- **Targets:** `ASLNTFLX, OSRP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_NETFLEX_OSRP | 1 | 3605 | 18 | `s_m_Load_NETFLEX_OSRP` |
| 2 | Load_OSRP2 | 1 | 3980 | 18 | `s_m_Load_OSRP2` |

#### DG_493 — 2 members
- **Sources:** `NETWORKELEMENT, NETWORKELEMENT1, NETWORK_ELEMENT_LAB`
- **Targets:** `ASLNTFLX, NETWORKELEMENT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_NETWORKELEMENT2 | 1 | 3607 | 11 | `s_m_Load_NETWORKELEMENT2` |
| 2 | Load_NETWORKELEMENT_NOKIA1830 | 1 | 3609 | 11 | `s_m_Load_NETWORKELEMENT_NOKIA1830` |

#### DG_494 — 2 members
- **Sources:** `OCH_CRS`
- **Targets:** `CRPL_NETFLEX, OCH_CRS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_OCH_CRS | 1 | 3715 | 2 | `s_m_Load_OCH_CRS` |
| 2 | OCH_CRS_NOKIA | 1 | 3717 | 2 | `s_m_Load_OCH_CRS_NOKIA` |

#### DG_495 — 2 members
- **Sources:** `ODU_CRS`
- **Targets:** `CRPL_NETFLEX, ODU_CRS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_ODU_CRS | 1 | 3724 | 2 | `s_m_Load_ODU_CRS` |
| 2 | ODU_CRS_NOKIA | 1 | 3726 | 2 | `s_m_Load_ODU_CRS_NOKIA` |

#### DG_496 — 2 members
- **Sources:** `OPPORTUNITYTEAMMEMBER, TGT_OPPORTUNITYTEAMMEMBER`
- **Targets:** `FF_LOAD_STATUS, OPPORTUNITYTEAMMEMBER, SALESFORCE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_OPPORTUNITYTEAMMEMBER | 1 | 3830 | 13 | `s_m_Load_OPPORTUNITYTEAMMEMBER` |
| 2 | Load_OPPORTUNITYTEAMMEMBER_MB | 1 | 3831 | 13 | `s_m_Load_OPPORTUNITYTEAMMEMBER_MB` |

#### DG_497 — 2 members
- **Sources:** `OSRP`
- **Targets:** `CRPL_NETFLEX, OSRP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_OSRP | 1 | 3979 | 2 | `s_m_Load_OSRP` |
| 2 | Load_OSRP_SRVR1 | 1 | 3981 | 2 | `s_m_Load_OSRP_SRVR1` |

#### DG_498 — 2 members
- **Sources:** `PARENT_TRANSACTION, PARENT_TRANSACTION1, PARENT_TRANSACTION3`
- **Targets:** `DRIVING_KEY1, FF_LOAD_STATUS, PARENT_TRANSACTION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_PARENT_TRANSACTION | 1 | 4021 | 15 | `s_m_Load_PARENT_TRANSACTION` |
| 2 | PARENT_TRANSACTION_HIST | 1 | 4022 | 15 | `s_m_Load_PARENT_TRANSACTION_HIST` |

#### DG_499 — 2 members
- **Sources:** `PHYSICALPORT`
- **Targets:** `CRPL_NETFLEX, PHYSICALPORT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_PHYSICALPORT | 1 | 4104 | 2 | `s_m_Load_PHYSICALPORT` |
| 2 | Load_PHYSICALPORT_SRVR2 | 1 | 4105 | 2 | `s_m_Load_PHYSICALPORT_SRVR2` |

#### DG_500 — 2 members
- **Sources:** `SL_ORDER, SL_ORDER1, SL_ORDER4`
- **Targets:** `DRIVING_KEY1, FF_LOAD_STATUS, SL_ORDER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_SL_ORDER | 1 | 5134 | 15 | `s_m_Load_SL_ORDER` |
| 2 | SL_ORDER_hist | 1 | 5135 | 15 | `s_m_Load_SL_ORDER_hist` |

#### DG_501 — 2 members
- **Sources:** `SUBCASE_DETAIL`
- **Targets:** `SUBCASE_DETAIL, TTEKMART`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_SUBCASE_DETAIL | 1 | 5363 | 3 | `s_m_Load_SUBCASE_DETAIL` |
| 2 | ONE_TIME_LOAD | 1 | 6814 | 3 | `s_m_SUBCASE_DETAIL_ONE_TIME_LOAD` |

#### DG_502 — 2 members
- **Sources:** `TASK, WORKITEM`
- **Targets:** `TASK_PERFORMER`
- **Lookups:** `EMPLOYEE, EMPLOYEE_LKP, GROUPUSERROLE, PROCESSTEMPLATE, TASK +4 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_TASK_PERFORMER | 30 | 12176 | 29 | `s_m_Load_TASK_PERFORMER` |
| 2 | TASK_PERFORMER_NRT | 30 | 12177 | 29 | `s_m_Load_TASK_PERFORMER_NRT` |

#### DG_503 — 2 members
- **Sources:** `TID`
- **Targets:** `TID_COUNT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_TID_COUNT | 2 | 8384 | 2 | `s_m_Load_TID_COUNT` |
| 2 | TID_COUNT_NOKIA1830 | 2 | 8464 | 2 | `s_m_TID_COUNT_NOKIA1830` |

#### DG_504 — 2 members
- **Sources:** `TOPOLOGY`
- **Targets:** `CRPL_NETFLEX, TOPOLOGY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_TOPOLOGY_NOKIA | 1 | 6173 | 2 | `s_m_Load_TOPOLOGY_NOKIA` |
| 2 | load_TOPOLOGY | 1 | 7534 | 2 | `s_m_load_TOPOLOGY` |

#### DG_505 — 2 members
- **Sources:** `EON_PATH, EON_SEGMENT`
- **Targets:** `EON, TRAIL_STG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_TRAIL_STAGING | 2 | 8394 | 3 | `s_m_Load_TRAIL_STAGING` |
| 2 | Load_TRAIL_STG | 2 | 8395 | 3 | `s_m_Load_TRAIL_STG` |

#### DG_506 — 2 members
- **Sources:** `SUPPLIER, SUPPLIER1, VENDOR, VENDOR1, VENDOR2`
- **Targets:** `DUMMY_TARGET, VENDOR`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Load_VENDOR_SAM | 10 | 9809 | 19 | `s_m_Load_VENDOR_SAM` |
| 2 | VENDOR_SAM_LATAM | 10 | 9810 | 19 | `s_m_Load_VENDOR_SAM_LATAM` |

#### DG_507 — 2 members
- **Sources:** `LOCALFOOTPRINTVIPER_RPT`
- **Targets:** `FF_LOCALFOOTPRINT_VIPER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Local_Footprint_Sonus | 3 | 8745 | 1 | `s_m_Generate_Report_Local_Footprint_Sonus` |
| 2 | local_footprint_viper | 3 | 8747 | 1 | `s_m_Generate_Report_local_footprint_viper` |

#### DG_508 — 2 members
- **Sources:** `ACCRUAL_CHARGE, ACCRUAL_CHARGE_MJE_EXPORT_SAP, DSL_AIM`
- **Targets:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, DSL_AIM`
- **Lookups:** `GL_ACCOUNT, GL_COMPANY`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MJE_EXPORT_SAP | 23 | 11101 | 22 | `s_m_Load_ACCRUAL_CHARGE_DETAIL_MJE_EXPORT_SAP` |
| 2 | MJE_EXPORT_SAP | 23 | 11109 | 22 | `s_m_Load_ACCRUAL_CHARGE_MJE_EXPORT_SAP` |

#### DG_509 — 2 members
- **Sources:** `CAVSMT00, CAVSMT001`
- **Targets:** `FF_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MMS_Health_Check2 | 1 | 6718 | 2 | `s_m_MMS_Health_Check2` |
| 2 | MMS_Health_Check3 | 1 | 6719 | 2 | `s_m_MMS_Health_Check3` |

#### DG_510 — 2 members
- **Sources:** `CIRCUIT_DETAIL, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL1`
- **Targets:** `SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_CIRCUIT, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MRC_SAM_EMEA | 20 | 10700 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ACCT_MRC_SAM_EMEA` |
| 2 | MRC_SAM_EMEA | 20 | 10709 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ASG_MRC_SAM_EMEA` |

#### DG_511 — 2 members
- **Sources:** `CIRCUIT_DETAIL, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL1`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_CIRCUIT, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MRC_SAM_LATAM | 20 | 10701 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ACCT_MRC_SAM_LATAM` |
| 2 | MRC_SAM_LATAM | 20 | 10710 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_ASG_MRC_SAM_LATAM` |

#### DG_512 — 2 members
- **Sources:** `CIRCUIT_DETAIL, SUPP_INV_DTL_MRC`
- **Targets:** `CODS_NETEX, SUPP_INV_DTL_MRC`
- **Lookups:** `CIRCUIT_DETAIL, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MRC_SAM_LATAM | 24 | 11237 | 10 | `s_m_Load_NETEX_SUPP_INV_DTL_MRC_SAM_LATAM` |
| 2 | DTL_MRC_SAM | 24 | 11311 | 10 | `s_m_load_NETEX_SUPP_INV_DTL_MRC_SAM` |

#### DG_513 — 2 members
- **Sources:** `ONETIME_UPD_SRC`
- **Targets:** `TGT_ONETIME_UPD`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | MRII_Onetime_update | 1 | 7492 | 2 | `s_m_load_NETEX_SID_MRII_Onetime_update` |
| 2 | MRII_Onetime_update | 1 | 7493 | 2 | `s_m_load_NETEX_USOC_MRII_Onetime_update` |

#### DG_514 — 2 members
- **Sources:** `CIRC_PATH_INST, NC_ENDPOINT_DETAIL`
- **Targets:** `CODS_NETINV, NC_ENDPOINT_DETAIL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NCENDPNT_Del_A | 2 | 8390 | 5 | `s_m_Load_TLC_NCENDPNT_Del_A` |
| 2 | NCENDPNT_Del_Z | 2 | 8391 | 5 | `s_m_Load_TLC_NCENDPNT_Del_Z` |

#### DG_515 — 2 members
- **Sources:** `AE2E_CLARIFY_PREP, AE2E_ENDSTATE_GRANITE_PREP, AE2E_JOB_LOG, AE2E_SAVVION_STG, AE2E_SAVVION_STG1`
- **Targets:** `AE2E_JOB_LOG, AE2E_SAVVION_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETDIS_BPMS_PREP | 43 | 12935 | 10 | `s_m_Load_AE2E_UNITY_NETDIS_BPMS_PREP` |
| 2 | NETINS_BPMS_PREP | 43 | 12937 | 10 | `s_m_Load_AE2E_UNITY_NETINS_BPMS_PREP` |

#### DG_516 — 2 members
- **Sources:** `AE2E_BTP_STG3, AE2E_BTP_STG31, AE2E_BTP_STG311, AE2E_ENDSTATE_GRANITE_PREP, AE2E_ENDSTATE_GRANITE_PREP1 +2 more`
- **Targets:** `AE2E_BILL_TAMER_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETDIS_BTP_PREP | 24 | 11211 | 14 | `s_m_Load_AE2E_UNITY_NETDIS_BTP_PREP` |
| 2 | NETINS_BTP_PREP | 24 | 11212 | 14 | `s_m_Load_AE2E_UNITY_NETINS_BTP_PREP` |

#### DG_517 — 2 members
- **Sources:** `AE2E_AMT_PREP, AE2E_AMT_PREP1, AE2E_AMT_PREP11, AE2E_CLARIFY_STG, AE2E_CLARIFY_STG1 +6 more`
- **Targets:** `AE2E_CLARIFY_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETDIS_CFY_PREP | 42 | 12926 | 22 | `s_m_Load_AE2E_UNITY_NETDIS_CFY_PREP` |
| 2 | NETINS_CFY_PREP | 42 | 12929 | 22 | `s_m_Load_AE2E_UNITY_NETINS_CFY_PREP` |

#### DG_518 — 2 members
- **Sources:** `AE2E_AMT_PREP, AE2E_AMT_PREP1, AE2E_CLEAR_SUPPORT_STG, AE2E_CLEAR_SUPPORT_STG1, AE2E_CLEAR_SUPPORT_STG11 +6 more`
- **Targets:** `AE2E_CLEAR_SUPPORT_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETDIS_CS_PREP | 42 | 12927 | 22 | `s_m_Load_AE2E_UNITY_NETDIS_CS_PREP` |
| 2 | NETINS_CS_PREP | 42 | 12930 | 22 | `s_m_Load_AE2E_UNITY_NETINS_CS_PREP` |

#### DG_519 — 2 members
- **Sources:** `AE2E_CLEAR_SUPPORT_PREP, AE2E_JOB_LOG, RFA_MASTER_STG`
- **Targets:** `AE2E_JOB_LOG, AE2E_RFA_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETDIS_RFA_PREP | 43 | 12936 | 4 | `s_m_Load_AE2E_UNITY_NETDIS_RFA_PREP` |
| 2 | NETINS_RFA_PREP | 43 | 12938 | 4 | `s_m_Load_AE2E_UNITY_NETINS_RFA_PREP` |

#### DG_520 — 2 members
- **Sources:** `AE2E_AMT_PREP, AE2E_ENDSTATE_GRANITE_PREP, AE2E_JOB_LOG, AE2E_NEXTGEN_PREP, AE2E_TRAILBLAZER_STG +2 more`
- **Targets:** `AE2E_JOB_LOG, AE2E_TRAIL_BLAZER_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETDIS_TRAIL_PREP | 42 | 12928 | 14 | `s_m_Load_AE2E_UNITY_NETDIS_TRAIL_PREP` |
| 2 | NETINS_TRAIL_PREP | 42 | 12931 | 14 | `s_m_Load_AE2E_UNITY_NETINS_TRAIL_PREP` |

#### DG_521 — 2 members
- **Sources:** `AE2E_ENDSTATE_GRANITE_PREP, AE2E_ENDSTATE_GRANITE_PREP1, AE2E_ENDSTATE_GRANITE_PREP111, AE2E_ENDSTATE_GRANITE_PREP112, AE2E_ENDSTATE_GRANITE_PREP2 +6 more`
- **Targets:** `AE2E_JOB_LOG, AE2E_XLINK_CV_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETDIS_XLINK_PREP | 3 | 8788 | 22 | `s_m_Load_AE2E_UNITY_NETDIS_XLINK_PREP` |
| 2 | NETINS_XLINK_PREP | 3 | 8790 | 22 | `s_m_Load_AE2E_UNITY_NETINS_XLINK_PREP` |

#### DG_522 — 2 members
- **Sources:** `SUPPLIER_LOCATION, VENDOR_LOCATION`
- **Targets:** `SUPPLIER_LOCATION`
- **Lookups:** `AP_VENDOR_LOCATION, SUPPLIER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETEX_SUPPLIER_LOCATION | 10 | 9791 | 9 | `s_m_Load_NETEX_SUPPLIER_LOCATION` |
| 2 | SUPPLIER_LOCATION_CTL | 10 | 9792 | 9 | `s_m_Load_NETEX_SUPPLIER_LOCATION_CTL` |

#### DG_523 — 2 members
- **Sources:** `NETEX_VNAM_EXTRACT, NETEX_VNAM_EXTRACT1`
- **Targets:** `DSL_MARGIN, NETEX_VNAM_EXTRACT`
- **Lookups:** `CUSTOMER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETEX_VNAM_EXTRACT | 21 | 10875 | 13 | `s_m_Load_NETEX_VNAM_EXTRACT` |
| 2 | VNAM_EXTRACT_OneTimeLoad | 21 | 10876 | 13 | `s_m_Load_NETEX_VNAM_EXTRACT_OneTimeLoad` |

#### DG_524 — 2 members
- **Sources:** `OCH_CRS, TID`
- **Targets:** `ASLNTFLX, OCH_CRS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETFLEX_OCH_CRS | 2 | 8165 | 17 | `s_m_Load_NETFLEX_OCH_CRS` |
| 2 | OCH_CRS_NOKIA1830 | 2 | 8190 | 17 | `s_m_Load_OCH_CRS_NOKIA1830` |

#### DG_525 — 2 members
- **Sources:** `NETWORK_ORDER_COMPONENT, PROCESS_DATASLOT_KEY_VALUES`
- **Targets:** `NETWORK_ORDER_COMPONENT`
- **Lookups:** `NETWORK_ORDER_COMPONENT, PROCESS`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETWORK_ORDER_COMPONENT | 22 | 11001 | 12 | `s_m_Load_NETWORK_ORDER_COMPONENT` |
| 2 | ORDER_COMPONENT_NRT | 22 | 11009 | 12 | `s_m_Load_NETWORK_ORDER_COMPONENT_NRT` |

#### DG_526 — 2 members
- **Sources:** `PRODUCT_LOCATION, QOA_LOCATION, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_LOCATION`
- **Lookups:** `ADDRESS, GL_SEG2_PROFIT_CTR, L3AR_GL_PROFIT_CENTER, PHYS_STRUCT_GEOCODE, PROD_LOCATION_REGION_LKP +1 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NETWORX_PRODUCT_LOCATION | 4 | 9114 | 12 | `s_m_Load_NETWORX_PRODUCT_LOCATION` |
| 2 | SDP_PRODUCT_LOCATION | 26 | 11508 | 12 | `s_m_Load_SDP_PRODUCT_LOCATION` |

#### DG_527 — 2 members
- **Sources:** `NTSF_FCST_DTL`
- **Targets:** `NTSF_SNAP_AM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | NTSF_SNAP_AM | 31 | 12304 | 2 | `s_m_Load_NTSF_SNAP_AM` |
| 2 | NTSF_SNAP_AM | 31 | 12344 | 2 | `s_m_NTSF_SNAP_AM` |

#### DG_528 — 2 members
- **Sources:** `PROCESS_PARAMETER, PROCESS_PARAMETER1`
- **Targets:** `PROCESS_PARAMETER`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | N_to_Y | 1 | 6835 | 3 | `s_m_Toggle_Month_End_Param_From_N_to_Y` |
| 2 | Advance_Processing_Month | 1 | 6836 | 7 | `s_m_Toggle_Month_End_Param_From_Y_to_N_And_Advance_Processing_Month` |

#### DG_529 — 2 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, ORDER_PRODUCT_COMPNT`
- **Targets:** `CODS, ORDER_PRODUCT_COMPNT, ORDER_PRODUCT_COMPNT_DQC, ORDER_PRODUCT_ENDPNT, ORDER_PRODUCT_ENDPNT_DQC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ODSID_MisMatch_update | 5 | 9179 | 7 | `ONE_TIME_s_m_Load_BM_DQC_ODSID_MisMatch_update` |
| 2 | ODSID_MisMatch_update | 12 | 9954 | 7 | `s_m_Load_BM_DQC_ODSID_MisMatch_update` |

#### DG_530 — 2 members
- **Sources:** `ODU_CRS, ODU_CRS1, TID`
- **Targets:** `ASLNTFLX, ODU_CRS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ODU_CRS_NOKIA1830 | 2 | 8192 | 14 | `s_m_Load_ODU_CRS_NOKIA1830` |
| 2 | NETFLEX_ODU_CRS | 2 | 8585 | 17 | `s_m_load_NETFLEX_ODU_CRS` |

#### DG_531 — 2 members
- **Sources:** `OFFNET_ENDPNT, OFFNET_ENDPNT2, OFFNET_ORDER`
- **Targets:** `CODS_OFFNET, OFFNET_ENDPNT`
- **Lookups:** `OFFNET_ORDER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | OFFNET_ENDPNT_COASTAL | 33 | 12492 | 10 | `s_m_Load_OFFNET_ENDPNT_COASTAL` |
| 2 | OFFNET_ENDPNT_WEBVFO | 33 | 12493 | 10 | `s_m_Load_OFFNET_ENDPNT_WEBVFO` |

#### DG_532 — 2 members
- **Sources:** `RA_CUST_TRX_LINE_GL_DIST_ALL, RA_CUST_TRX_LINE_GL_DIST_ALL11`
- **Targets:** `RA_CUST_TRX_LINE_GL_DIST_ALL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ONE_TIME_LOAD | 1 | 4628 | 4 | `s_m_Load_RA_CUST_TRX_LINE_GL_DIST_ALL_ONE_TIME_LOAD` |
| 2 | GL_DIST_IDS | 1 | 4629 | 4 | `s_m_Load_RA_CUST_TRX_LINE_GL_DIST_ALL_ONE_TIME_LOAD_MISSING_GL_DIST_IDS` |

#### DG_533 — 2 members
- **Sources:** `AE2E_AM_OFFNET_MGR_PREP, AE2E_AM_OFFNET_MGR_PREP1, AE2E_JOB_LOG, WILTEL_OPENCI_FGD_STG, WILTEL_OPENCI_FGD_STG1`
- **Targets:** `AE2E_AM_OPENCI_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | OPENCI_PREP_FGDD | 37 | 12867 | 8 | `s_m_Load_AE2E_AM_OPENCI_PREP_FGDD` |
| 2 | OPENCI_PREP_FGDI | 37 | 12868 | 8 | `s_m_Load_AE2E_AM_OPENCI_PREP_FGDI` |

#### DG_534 — 2 members
- **Sources:** `SSL_LOAD_CONTROL`
- **Targets:** `DUMMY_TGT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_ALL_Validation | 1 | 6767 | 2 | `s_m_Refresh_SSL_IQONS_CKT_ORDER_ALL_Validation` |
| 2 | CIRCUIT_ID_Validation | 1 | 6769 | 2 | `s_m_Refresh_SSL_METRO_VW_CV_CIRCUIT_ID_Validation` |

#### DG_535 — 2 members
- **Sources:** `SALES_ORDER_LINE_HIST, SALES_ORDER_LINE_HIST1, SALES_ORDER_LINE_STG`
- **Targets:** `DSL_SALES_PERIOD, SALES_ORDER_LINE_HIST`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_LINE_HIST | 34 | 12632 | 12 | `s_m_Load_SALES_ORDER_LINE_HIST` |
| 2 | HIST_Mid_Month | 34 | 12633 | 12 | `s_m_Load_SALES_ORDER_LINE_HIST_Mid_Month` |

#### DG_536 — 2 members
- **Sources:** `SALES_ORDER_LINE_STG, STG_SALES_ORDER_LINE_BULK`
- **Targets:** `DSL_SALES_PERIOD, FF_SALES_ORDER_LINE_BULK, SALES_ORDER_LINE_STG`
- **Lookups:** `BILLING_ACCOUNT, COMP_LOB_PLAN_HIST, COMP_PRODUCT_FACTOR_HIST, CURRENCY_EXCHANGE_RATE, CUSTOMER +4 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_LINE_STG | 24 | 11217 | 13 | `s_m_Load_BULK_SALES_ORDER_LINE_STG` |
| 2 | STG_Mid_Month | 24 | 11218 | 13 | `s_m_Load_BULK_SALES_ORDER_LINE_STG_Mid_Month` |

#### DG_537 — 2 members
- **Sources:** `SALES_ORDER_LINE_HIST, SALES_ORDER_LINE_STG, SALES_ORDER_LINE_STG1, TABLE_CONTRACT`
- **Targets:** `DSL_SALES_PERIOD, SALES_ORDER_LINE_STG`
- **Lookups:** `BILLING_ACCOUNT, CURRENCY_EXCHANGE_RATE, CUSTOMER, DSP_COMP_LOB_F79, DSP_COMP_PRODUCT_F77 +15 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_LINE_STG | 33 | 12471 | 8 | `s_m_Load_CLARIFY_SALES_ORDER_LINE_STG` |
| 2 | STG_Mid_Month | 33 | 12472 | 8 | `s_m_Load_CLARIFY_SALES_ORDER_LINE_STG_Mid_Month` |

#### DG_538 — 2 members
- **Sources:** `CUST_ORDER_ATTRIB_REV, DSL_SALES_PERIOD, SALES_ORDER_LINE_STG, SALES_ORDER_LINE_STG1, V_CUSTOMER_ORDER_PRODUCT +1 more`
- **Targets:** `DSL_SALES_PERIOD, SALES_ORDER_LINE_STG`
- **Lookups:** `BILLING_ACCOUNT, BILLING_PRODUCT_COMPNT, CIRCUIT_ORDER_STG, COMP_LOB_PLAN_HIST, COMP_PRODUCT_FACTOR_HIST +25 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_LINE_STG | 33 | 12473 | 8 | `s_m_Load_CODS_SALES_ORDER_LINE_STG` |
| 2 | STG_Mid_Month | 33 | 12474 | 8 | `s_m_Load_CODS_SALES_ORDER_LINE_STG_Mid_Month` |

#### DG_539 — 2 members
- **Sources:** `DSL_SALES_PERIOD, SALES_ORDER_LINE_STG, SALES_ORDER_LINE_STG1, TN_LINE_ORDER, TN_LINE_ORDER_PRICE +1 more`
- **Targets:** `DSL_SALES_PERIOD, SALES_ORDER_LINE_STG`
- **Lookups:** `COMP_LOB_PLAN_HIST, COMP_PRODUCT, COMP_PRODUCT_FACTOR_HIST, CURRENCY_EXCHANGE_RATE, CUSTOMER +7 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_LINE_STG | 33 | 12475 | 8 | `s_m_Load_CODS_TN_SALES_ORDER_LINE_STG` |
| 2 | STG_Mid_Month | 33 | 12476 | 8 | `s_m_Load_CODS_TN_SALES_ORDER_LINE_STG_Mid_Month` |

#### DG_540 — 2 members
- **Sources:** `SALES_ORDER_LINE_HIST, SALES_ORDER_LINE_STG, V_CUSTOMER_ORDER_PRODUCT`
- **Targets:** `DSL_SALES_PERIOD, SALES_ORDER_LINE_STG`
- **Lookups:** `CIRCUIT_ORDER_STG, COMP_PRODUCT, CURRENCY_EXCHANGE_RATE, CUSTOMER, CUSTOMER_ATTRIBUTION +21 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_LINE_STG | 35 | 12747 | 8 | `s_m_REVISE_SALES_ORDER_LINE_STG` |
| 2 | STG_Mid_Month | 35 | 12748 | 8 | `s_m_REVISE_SALES_ORDER_LINE_STG_Mid_Month` |

#### DG_541 — 2 members
- **Sources:** `ORDER_MILESTONE, ORDER_MILESTONE1, ORDER_MILESTONE_CURR, ORDER_MILESTONE_CURR2`
- **Targets:** `FF_LOAD_STATUS, LUMEN_SERVICENOW, ORDER_MILESTONE_CURR, ORD_MILESTONE_CURR`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_MILESTONE_CURR | 1 | 3898 | 11 | `s_m_Load_ORDER_MILESTONE_CURR` |
| 2 | ORD_MILESTONE_CURR | 1 | 3938 | 11 | `s_m_Load_ORD_MILESTONE_CURR` |

#### DG_542 — 2 members
- **Sources:** `CDW_LOAD_RULE, CIRCUIT_ORDER_STG, CUSTOMER, CUSTOMER_ORDER_PRODUCT, ORDER_PRODUCT_COMPNT +3 more`
- **Targets:** `CODS, DUMMY_TGT, ORDER_PRODUCT_COMPNT`
- **Lookups:** `BANDWIDTH_XREF, CURRENCY_EXCHANGE_RATE, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_COMPNT | 18 | 10562 | 23 | `s_m_Load_ENS_ORDER_PRODUCT_COMPNT` |
| 2 | ORDER_PRODUCT_COMPNT | 28 | 11776 | 25 | `s_m_Load_VLOCITY_ORDER_PRODUCT_COMPNT` |

#### DG_543 — 2 members
- **Sources:** `ORDER_PRODUCT_COMPNT, ORDER_PRODUCT_ELEMENT, PRODUCT_COMPNT_PRICE`
- **Targets:** `V_ORDER_PRODUCT_COMPNT`
- **Lookups:** `CUSTOMER_ORDER, EON_LOOP_DATES, GL_MGMT_PRODUCT, GL_SEGMENT_PRODUCT_XREF, HYBRID_ORDER_SEGMENT +4 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_COMPNT | 30 | 12192 | 26 | `s_m_Load_V_ORDER_PRODUCT_COMPNT` |
| 2 | ORDER_PRODUCT_COMPNT1 | 30 | 12193 | 26 | `s_m_Load_V_ORDER_PRODUCT_COMPNT1` |

#### DG_544 — 2 members
- **Sources:** `CIRCUIT_ORDER_STG, ORDER_PRODUCT_ELEMENT`
- **Targets:** `CODS, ORDER_PRODUCT_ELEMENT`
- **Lookups:** `ORDER_PRODUCT_COMPNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_ELEMENT | 23 | 11163 | 8 | `s_m_Load_PROD_ORDER_PRODUCT_ELEMENT` |
| 2 | ORDER_PRODUCT_ELEMENT | 26 | 11505 | 10 | `s_m_Load_SDP_ORDER_PRODUCT_ELEMENT` |

#### DG_545 — 2 members
- **Sources:** `CIRCUIT_ORDER_STG, ORDER_PRODUCT_ELEMENT`
- **Targets:** `CODS, ORDER_PRODUCT_ELEMENT`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, ORDER_PRODUCT_COMPNT, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_ELEMENT | 29 | 11929 | 10 | `s_m_Load_SWIFT_ORDER_PRODUCT_ELEMENT` |
| 2 | ORDER_PRODUCT_ELEMENT | 29 | 11963 | 10 | `s_m_Load_VLOCITY_ORDER_PRODUCT_ELEMENT` |

#### DG_546 — 2 members
- **Sources:** `CIRCUIT_ORDER_STG, ORDER_PRODUCT_ENDPNT, ORDER_PRODUCT_ENDPNT1`
- **Targets:** `ORDER_PRODUCT_ENDPNT`
- **Lookups:** `CUSTOMER_ORDER_PRODUCT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_ENDPNT | 11 | 9834 | 8 | `s_m_LOAD_PROD_ORDER_PRODUCT_ENDPNT` |
| 2 | ORDER_PRODUCT_ENDPNT | 12 | 9956 | 9 | `s_m_Load_BM_ORDER_PRODUCT_ENDPNT` |

#### DG_547 — 2 members
- **Sources:** `CIRCUIT_ORDER_STG, ORDER_PRODUCT_ENDPNT, ORDER_PRODUCT_ENDPNT1, PRODUCT_SERVICE_ADDRESS_REL, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, ORDER_PRODUCT_ENDPNT`
- **Lookups:** `CUSTOMER_ORDER_PRODUCT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_ENDPNT | 22 | 10995 | 10 | `s_m_Load_LUMEN_SERVICENOW_ORDER_PRODUCT_ENDPNT` |
| 2 | ORDER_PRODUCT_ENDPNT | 28 | 11765 | 12 | `s_m_Load_SWIFT_ORDER_PRODUCT_ENDPNT` |

#### DG_548 — 2 members
- **Sources:** `ORDER_PRODUCT_ENDPNT, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, ORDER_PRODUCT_ENDPNT`
- **Lookups:** `CUSTOMER_ORDER_PRODUCT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PRODUCT_ENDPNT | 22 | 11028 | 12 | `s_m_Load_ORACLE2E_ORDER_PRODUCT_ENDPNT` |
| 2 | ORDER_PRODUCT_ENDPNT | 29 | 11987 | 12 | `s_m_load_CLARIFY_ORDER_PRODUCT_ENDPNT` |

#### DG_549 — 2 members
- **Sources:** `CIRCUIT_ORDER_STG`
- **Targets:** `CODS_STG, STG_CUSTOMER_ORDER_PRODUCT, STG_CUST_ORDER_PROD_KEY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_PROD_KEY | 4 | 9072 | 2 | `s_m_Load_BM_STG_CUST_ORDER_PROD_KEY` |
| 2 | ORDER_PROD_KEY | 4 | 9090 | 3 | `s_m_Load_ENS_MM_STG_CUST_ORDER_PROD_KEY` |

#### DG_550 — 2 members
- **Sources:** `QOA_LOCATION`
- **Targets:** `FF_QOA_LOCATION`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_STG_EIS | 2 | 8031 | 1 | `s_m_Load_CIRCUIT_ORDER_STG_EIS` |
| 2 | ORDER_STG_drop | 2 | 8037 | 1 | `s_m_Load_CIRCUIT_ORDER_STG_drop` |

#### DG_551 — 2 members
- **Sources:** `OFFNET_MATCH, OFFNET_MATCH1, OFFNET_MATCH3, OFFNET_SEARCH, OFFNET_SEARCH_BPMS_ASR`
- **Targets:** `OFFNET_MATCH, OFFNET_MATCH_REASON`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ORDER_TO_AMT | 21 | 10887 | 14 | `s_m_Load_OFFNET_MATCH_REASON_ORDER_TO_AMT` |
| 2 | ASR_TO_BPMS | 25 | 11464 | 14 | `s_m_load_OFFNET_MATCH_REASON_ASR_TO_BPMS` |

#### DG_552 — 2 members
- **Sources:** `SALES_ORDER_PERIOD, SALES_ORDER_PERIOD1`
- **Targets:** `DSL_SALES_PERIOD, SALES_ORDER_PERIOD`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Open_Reporting_periods | 1 | 563 | 18 | `s_m_Close_Open_Reporting_periods` |
| 2 | open_reporting_periods | 1 | 7569 | 18 | `s_m_opp_close_open_reporting_periods` |

#### DG_553 — 2 members
- **Sources:** `ACCRUAL_CHARGE_HIST`
- **Targets:** `FF_PARAMTERS_FOR_AC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PARAMETERS_ACCRUAL_CHARGE | 23 | 11091 | 2 | `s_m_GENERATE_PARAMETERS_ACCRUAL_CHARGE` |
| 2 | ACCRUAL_CHARGE_OCC | 23 | 11094 | 2 | `s_m_GENERATE_PARAMETERS_ACCRUAL_CHARGE_OCC` |

#### DG_554 — 2 members
- **Sources:** `PARENT_TRANS_DETAIL, PARENT_TRANS_DETAIL1, PARENT_TRANS_DETAIL3`
- **Targets:** `DRIVING_KEY1, FF_LOAD_STATUS, PARENT_TRANS_DETAIL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PARENT_TRANS_DETAIL | 1 | 4023 | 15 | `s_m_Load_PARENT_TRANS_DETAIL` |
| 2 | TRANS_DETAIL_HIST | 1 | 4024 | 15 | `s_m_Load_PARENT_TRANS_DETAIL_HIST` |

#### DG_555 — 2 members
- **Sources:** `GL_CODE_COMBINATIONS, GL_JE_BATCHES, GL_JE_HEADERS, GL_JE_LINES, GL_SETS_OF_BOOKS_11I +2 more`
- **Targets:** `DSL_AIM, NETEX_ACCRUAL_ALLOC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PERCENTAGES_GC_USF | 2 | 8133 | 8 | `s_m_Load_NETEX_ALLOC_PERCENTAGES_GC_USF` |
| 2 | PERCENTAGES_L3_USF | 2 | 8134 | 8 | `s_m_Load_NETEX_ALLOC_PERCENTAGES_L3_USF` |

#### DG_556 — 2 members
- **Sources:** `F_PRODUCT_ACTIVITY, F_PRODUCT_ACTIVITY2`
- **Targets:** `DSL_UNT_PRD_ACTY, F_PRODUCT_ACTIVITY`
- **Lookups:** `CUST_ORDER_COMPNT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PPP_Ord_Details | 26 | 11541 | 4 | `s_m_Update_F_PRODUCT_ACTIVITY_PPP_Ord_Details` |
| 2 | Ord_Sales_Details | 26 | 11542 | 4 | `s_m_Update_F_PRODUCT_ACTIVITY_PPP_Ord_Sales_Details` |

#### DG_557 — 2 members
- **Sources:** `PRE_ORDER_RELATIONSHIP, PRODUCT_DEFINITION`
- **Targets:** `CODS, PRE_ORDER_RELATIONSHIP`
- **Lookups:** `PRE_ORDER_PRODUCT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRE_ORDER_RELATIONSHIP | 15 | 10180 | 10 | `s_m_Load_EIS_PRE_ORDER_RELATIONSHIP` |
| 2 | PRE_ORDER_RELATIONSHIP | 31 | 12317 | 10 | `s_m_Load_SWIFT_PRE_ORDER_RELATIONSHIP` |

#### DG_558 — 2 members
- **Sources:** `TN_LINE_ORDER_PRICE, TN_LINE_ORDER_PRICE1`
- **Targets:** `CODS_TN_STG, WRK_CPO_TN_LINE_ORDER_PRICE`
- **Lookups:** `CURRENCY_EXCHANGE_RATE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRICE_Initial_Install | 31 | 12289 | 5 | `s_m_Load_CPO_WRK_TN_LINE_ORDER_PRICE_Initial_Install` |
| 2 | ORDER_PRICE_Truncate | 31 | 12290 | 5 | `s_m_Load_CPO_WRK_TN_LINE_ORDER_PRICE_Truncate` |

#### DG_559 — 2 members
- **Sources:** `CIRCUIT_ORDER_STG, PRODUCT_COMPNT_ENDPNT, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_COMPNT_ENDPNT`
- **Lookups:** `ORDER_PRODUCT_COMPNT, PRODUCT_LOCATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_COMPNT_ENDPNT | 23 | 11140 | 12 | `s_m_Load_NETWORX_PRODUCT_COMPNT_ENDPNT` |
| 2 | PRODUCT_COMPNT_ENDPNT | 27 | 11608 | 10 | `s_m_Load_SDP_PRODUCT_COMPNT_ENDPNT` |

#### DG_560 — 2 members
- **Sources:** `BILLING_PRODUCT_COMPNT_CABS, BILLING_PRODUCT_COMPNT_CABS1, STG_BILLING_PRODUCT_COMPNT_ENS, STG_BILLING_PRODUCT_COMPNT_ENS1`
- **Targets:** `BILLING_PRODUCT_COMPNT, CODS_BILLING, CODS_BILLING_STG, STG_BILLING_PRODUCT_COMPNT_ENS`
- **Lookups:** `ASSET_PRODUCT, ASSET_PRODUCT_COMPNT, CDW_BPC_INCR_BAN_LIST_PRD, CUSTOMER_ORDER_PRODUCT, GL_COMPANY +5 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_COMPNT_ENS | 14 | 10111 | 24 | `s_m_Load_BILLING_PRODUCT_COMPNT_ENS` |
| 2 | PRODUCT_COMPNT_ENS1 | 14 | 10112 | 24 | `s_m_Load_BILLING_PRODUCT_COMPNT_ENS1` |

#### DG_561 — 2 members
- **Sources:** `RATE_CURRENCY_VALUES, SERVICE, SRC_KENAN_SERVICE, SRC_KENAN_SERVICE2`
- **Targets:** `BILLING_PRODUCT_COMPNT, CDW_COMMON, CODS_BILLING, DELETED_ROW`
- **Lookups:** `ASSET_PRODUCT, ASSET_PRODUCT_COMPNT, BILLING_ACCOUNT, BILLING_PRODUCT_COMPNT, BILL_INVOICE1 +5 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_COMPNT_KENANFX | 14 | 10116 | 25 | `s_m_Load_BILLING_PRODUCT_COMPNT_KENANFX` |
| 2 | MISSING_KENANFX_HISTORY | 14 | 10118 | 25 | `s_m_Load_BILLING_PRODUCT_COMPNT_MISSING_KENANFX_HISTORY` |

#### DG_562 — 2 members
- **Sources:** `CIRCUIT_ORDER_STG, PRODUCT_COMPNT_PRICE, PRODUCT_COMPNT_PRICE1, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_COMPNT_PRICE`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, ORDER_PRODUCT_COMPNT, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_COMPNT_PRICE | 15 | 10173 | 10 | `s_m_Load_CPO_PRODUCT_COMPNT_PRICE` |
| 2 | PRODUCT_COMPNT_PRICE | 28 | 11744 | 12 | `s_m_Load_SIEBEL8_LATAM_PRODUCT_COMPNT_PRICE` |

#### DG_563 — 2 members
- **Sources:** `CIRCUIT_ORDER_STG, PRODUCT_COMPNT_PRICE, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_COMPNT_PRICE`
- **Lookups:** `ORDER_PRODUCT_COMPNT, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_COMPNT_PRICE | 19 | 10617 | 11 | `s_m_Load_EASE_CABS_PRODUCT_COMPNT_PRICE` |
| 2 | PRODUCT_COMPNT_PRICE | 23 | 11141 | 12 | `s_m_Load_NETWORX_PRODUCT_COMPNT_PRICE` |

#### DG_564 — 2 members
- **Sources:** `PRODUCT_COMPNT_PRICE, SOURCE_TABLE_RECORD_COUNT`
- **Targets:** `CODS, DUMMY_TGT, PRODUCT_COMPNT_PRICE`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, ORDER_PRODUCT_COMPNT, PRODUCT_SPECIFICATION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_COMPNT_PRICE | 19 | 10638 | 11 | `s_m_Load_LUMEN_SERVICENOW_PRODUCT_COMPNT_PRICE` |
| 2 | PRODUCT_COMPNT_PRICE | 23 | 11152 | 12 | `s_m_Load_ORACLE2E_PRODUCT_COMPNT_PRICE` |

#### DG_565 — 2 members
- **Sources:** `PRODUCT_ENDPNT_MARGIN, PRODUCT_ENDPNT_MARGIN_OFFNET_SRC, PRODUCT_ENDPNT_MARGIN_OFFNET_TGT, PRODUCT_ENDPNT_MARGIN_ONNET_SRC, PRODUCT_ENDPNT_MARGIN_ONNET_TGT +1 more`
- **Targets:** `DSL_MARGIN, PRODUCT_ENDPNT_MARGIN`
- **Lookups:** `ECCKT_CUST_SERV_XREF_HIST, SERVICE_ENDPNT_MARGIN`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_ENDPNT_MARGIN | 20 | 10767 | 29 | `s_m_Load_PRODUCT_ENDPNT_MARGIN` |
| 2 | ENDPNT_MARGIN_OneTimeLoad | 20 | 10768 | 29 | `s_m_Load_PRODUCT_ENDPNT_MARGIN_OneTimeLoad` |

#### DG_566 — 2 members
- **Sources:** `CUSTOMER_ORDER_PRODUCT, ORDER_PRODUCT_INCR_AMT, ORDER_PRODUCT_INCR_AMT1`
- **Targets:** `CODS, ORDER_PRODUCT_INCR_AMT`
- **Lookups:** `CUSTOMER_ORDER, GEO_BILL_SCIDS, L3AR_GL_GOV_REV_VALUES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PRODUCT_INCR_AMT | 5 | 9232 | 10 | `s_m_LOAD_CPO_ORDER_PRODUCT_INCR_AMT` |
| 2 | PRODUCT_INCR_AMT | 11 | 9839 | 10 | `s_m_LOAD_SWIFT_ORDER_PRODUCT_INCR_AMT` |

#### DG_567 — 2 members
- **Sources:** `DH_GL_CO_ACCT_PROD, DH_GL_CO_ACCT_PROD1, D_REV_ACCT_CDMT, GL_PERIOD`
- **Targets:** `DH_GL_CO_ACCT_PROD, DSL_FINANCE, FF_DEFAULT_RECORDS`
- **Lookups:** `DH_GL_ACCOUNT, DH_GL_COMPANY, DH_GL_FIN_PRODUCT_LINE, GL_COMPANY, GL_PERIOD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PROD_CURR_MNTH | 7 | 9477 | 25 | `s_m_Load_DH_GL_CO_ACCT_PROD_CURR_MNTH` |
| 2 | PROD_NEXT_MNTH | 7 | 9478 | 25 | `s_m_Load_DH_GL_CO_ACCT_PROD_NEXT_MNTH` |

#### DG_568 — 2 members
- **Sources:** `SWP_PROD_PROF_PRE_ALLOC`
- **Targets:** `DUMMY_TGT, SWP_PROD_PROF_POST_ALLOC, SWP_PROD_PROF_PRE_ALLOC`
- **Lookups:** `V_GL_SEG2_HIER_MEMBER, V_GL_SEG3_HIER_MEMBER, V_GL_SEG4_HIER_MEMBER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | PROF_POST_ALLOC | 1 | 4390 | 9 | `s_m_Load_PROD_PROF_POST_ALLOC` |
| 2 | POST_RE_ALLOC | 1 | 4391 | 9 | `s_m_Load_PROD_PROF_POST_RE_ALLOC` |

#### DG_569 — 2 members
- **Sources:** `DUMMY_SRC`
- **Targets:** `FF_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Process_SSAS_Cube | 1 | 6750 | 4 | `s_m_Process_SSAS_Cube` |
| 2 | SSAS_Process_Dimensions | 1 | 6810 | 4 | `s_m_SSAS_Process_Dimensions` |

#### DG_570 — 2 members
- **Sources:** `FF_FMSRED_SUBFEED`
- **Targets:** `FMS_SUBSCRIBER_FEED`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RED_SUBSCRIBER_FEED | 3 | 8841 | 5 | `s_m_Load_FMS_RED_SUBSCRIBER_FEED` |
| 2 | FEED_FROM_FILE | 3 | 8842 | 5 | `s_m_Load_FMS_SUBSCRIBER_FEED_FROM_FILE` |

#### DG_571 — 2 members
- **Sources:** `E_INVOICE_FINAL`
- **Targets:** `FL_GENERATED_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REPORT_LINE_COUNT | 5 | 9189 | 8 | `s_m_GENERATE_PARAMETERS_F_JURSDCTN_REPORT_LINE_COUNT` |
| 2 | LINE_COUNT_TAXMART | 5 | 9190 | 6 | `s_m_GENERATE_PARAMETERS_F_JURSDCTN_REPORT_LINE_COUNT_TAXMART` |

#### DG_572 — 2 members
- **Sources:** `OOR_TP_RESP, OOR_TP_RESP21, ORDERXMLDATA`
- **Targets:** `OOR_TP_RESP, WEBVFO`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RESP_ADDRESS_MOD | 1 | 7507 | 17 | `s_m_load_OOR_TP_RESP_ADDRESS_MOD` |
| 2 | ORDER_INFO_NOTIFY | 1 | 7512 | 17 | `s_m_load_OOR_TP_RESP_ORDER_INFO_NOTIFY` |

#### DG_573 — 2 members
- **Sources:** `AE2E_JOB_LOG, AE2E_KENAN_PREP, AE2E_KENAN_PREP2, AE2E_REVAMART_STG`
- **Targets:** `AE2E_JOB_LOG, AE2E_REVAMART_PREP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVAMART_PREP_WCD | 44 | 12945 | 6 | `s_m_LOAD_AE2E_REVAMART_PREP_WCD` |
| 2 | REVAMART_PREP_WCI | 44 | 12946 | 6 | `s_m_LOAD_AE2E_REVAMART_PREP_WCI` |

#### DG_574 — 2 members
- **Sources:** `F_BILLING_ROLLUP, F_REVENUE_DETAIL_ALL`
- **Targets:** `F_GAAP_REVENUE`
- **Lookups:** `F_BILLING_ROLLUP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_CABS_TAXMART | 16 | 10330 | 12 | `s_m_LOAD_F_GAAP_REVENUE_CABS_TAXMART` |
| 2 | REVENUE_ENS_TAXMART | 16 | 10331 | 12 | `s_m_LOAD_F_GAAP_REVENUE_ENS_TAXMART` |

#### DG_575 — 2 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_MNTH, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2, F_RVN_CTGRY_ALLCTN_PRCNT_MNTH +2 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_MNTH`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_MNTH_007 | 25 | 11315 | 25 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_007` |
| 2 | REVENUE_MNTH_133 | 25 | 11319 | 25 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_133` |

#### DG_576 — 2 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_MNTH, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2, F_RVN_CTGRY_ALLCTN_PRCNT_MNTH +4 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_MNTH`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_MNTH_100 | 25 | 11316 | 31 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_100` |
| 2 | REVENUE_MNTH_S278 | 25 | 11329 | 31 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_MNTH_S278` |

#### DG_577 — 2 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_QRTR, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2, F_RVN_CTGRY_ALLCTN_PRCNT_QRTR +4 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_QRTR`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_QRTR_100 | 25 | 11331 | 31 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_100` |
| 2 | REVENUE_QRTR_S278 | 25 | 11345 | 31 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_S278` |

#### DG_578 — 2 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_QRTR, BILLED_REVENUE_RGLTRY_VW_QRTR1, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2 +3 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_QRTR`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_QRTR_206 | 25 | 11338 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_206` |
| 2 | REVENUE_QRTR_242 | 25 | 11339 | 27 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_QRTR_242` |

#### DG_579 — 2 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_YR, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2, F_RVN_CTGRY_ALLCTN_PRCNT_YR +2 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_YR`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_007 | 25 | 11346 | 25 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_007` |
| 2 | REVENUE_YR_624 | 25 | 11357 | 25 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_624` |

#### DG_580 — 2 members
- **Sources:** `BILLED_REVENUE_RGLTRY_VW_QRTR, F_GAAP_REVENUE, F_GAAP_REVENUE1, F_GAAP_REVENUE2, F_RVN_CTGRY_ALLCTN_PRCNT_YR +4 more`
- **Targets:** `DUMMY_TGT, F_RVN_CTGRY_ALLCTN_YR`
- **Lookups:** `D_COMBINED_COMPANY_CD`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_100 | 25 | 11347 | 31 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_100` |
| 2 | REVENUE_YR_S278 | 25 | 11361 | 31 | `s_m_CALC_ALLOCATION_USING_BILLED_REVENUE_YR_S278` |

#### DG_581 — 2 members
- **Sources:** `F_BILLING_ROLLUP, F_BILLING_ROLLUP1`
- **Targets:** `DUMMY_TGT, F_BILLED_REVENUE_YR, TAXMART`
- **Lookups:** `CCAT_EIS_CHARGE_ELIGIBLITY, F_FEDERAL_TAX_EXEMPTIONS, STATE_VALUES, U_CHARGE_ID_MAP, U_TAX_TYPE_CODE_MAP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REVENUE_YR_273 | 16 | 10323 | 28 | `s_m_LOAD_F_BILLED_REVENUE_YR_273` |
| 2 | REVENUE_YR_641 | 16 | 10325 | 28 | `s_m_LOAD_F_BILLED_REVENUE_YR_641` |

#### DG_582 — 2 members
- **Sources:** `VP_CORESITE_ORDERS, VP_ECCKT_REV_MATCH`
- **Targets:** `DSL_AML_REF, VP_ECCKT_REV_MATCH`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | REV_MATCH_PON | 3 | 8952 | 10 | `s_m_Load_VP_ECCKT_REV_MATCH_PON` |
| 2 | REV_MATCH_CORESITE | 3 | 9023 | 10 | `s_m_load_VP_ECCKT_REV_MATCH_CORESITE` |

#### DG_583 — 2 members
- **Sources:** `SERVICE, SERVICE_RESOURCE`
- **Targets:** `SERVICE_RESOURCE`
- **Lookups:** `EQUIPMENT, LOGICAL_PORT, NETWORK, PHYSICAL_PORT, SERVICE +2 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RM_SERVICE_RESOURCE | 34 | 12607 | 10 | `s_m_Load_AMDOCS_RM_SERVICE_RESOURCE` |
| 2 | ARM_SERVICE_RESOURCE | 34 | 12608 | 10 | `s_m_Load_ARM_SERVICE_RESOURCE` |

#### DG_584 — 2 members
- **Sources:** `BILLING_PRODUCT_COMPNT, E_INVOICE_FINAL, E_INVOICE_FINAL_SRC, F_BILLING_ROLLUP, F_BILLING_ROLLUP_TGT +1 more`
- **Targets:** `F_BILLING_ROLLUP, F_BILLING_ROLLUP_ENS`
- **Lookups:** `DH_GL_SEG4_PRODUCT_DEPT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ROLLUP_ENS_TAXMART | 15 | 10187 | 26 | `s_m_Load_F_BILLING_ROLLUP_ENS_TAXMART` |
| 2 | ENS_TAXMART_HISTORY | 15 | 10188 | 26 | `s_m_Load_F_BILLING_ROLLUP_ENS_TAXMART_HISTORY` |

#### DG_585 — 2 members
- **Sources:** `BM_TECHNOLOGY_XREF, TECHNOLOGY_XREF, TECHNOLOGY_XREF3`
- **Targets:** `DSL_CONSUMER, TECHNOLOGY_XREF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RSOR_TECHNOLOGY_XREF | 3 | 8916 | 11 | `s_m_Load_RSOR_TECHNOLOGY_XREF` |
| 2 | Load_TECHNOLOGY_XREF | 3 | 8943 | 11 | `s_m_Load_TECHNOLOGY_XREF` |

#### DG_586 — 2 members
- **Sources:** `ATTACHMENT, TICKET, TICKETEXPORTDATASET_20190128, TICKET_AUDIT, TICKET_RESPONSE`
- **Targets:** `ATTACHMENT, TICKET, TICKET_AUDIT, TICKET_RESPONSE`
- **Lookups:** `NATIONAL_CDC_CODES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RSPNS_ATTCHMNT_Green | 1 | 5974 | 47 | `s_m_Load_TCKT_AUDT_RSPNS_ATTCHMNT_Green` |
| 2 | RSPNS_ATTCHMNT_Red | 1 | 5976 | 47 | `s_m_Load_TCKT_AUDT_RSPNS_ATTCHMNT_Red` |

#### DG_587 — 2 members
- **Sources:** `PROCESS_SCHEDULE`
- **Targets:** `FF_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | RUN_NOW_FLAG | 1 | 632 | 2 | `s_m_Generate_CAPEX_RUN_NOW_FLAG` |
| 2 | NOW_FLAG_ASL | 1 | 649 | 2 | `s_m_Generate_RUN_NOW_FLAG_ASL` |

#### DG_588 — 2 members
- **Sources:** `R_DESIGN_VERSION`
- **Targets:** `AE2E_NG_R_DESIGN_VERSION_STAGE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | R_DESIGN_STAGE | 3 | 8761 | 3 | `s_m_LOAD_AE2E_NG_R_DESIGN_STAGE` |
| 2 | STG_ONETIME_LOAD | 3 | 8762 | 2 | `s_m_LOAD_AE2E_NG_R_DESIGN_STG_ONETIME_LOAD` |

#### DG_589 — 2 members
- **Sources:** `DRIVING_KEY`
- **Targets:** `DRIVING_KEY, DSL_SM`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Rsync_DRIVING_KEY | 1 | 6800 | 2 | `s_m_Rsync_DRIVING_KEY` |
| 2 | KEY_W_EVENT | 1 | 6801 | 2 | `s_m_Rsync_DRIVING_KEY_W_EVENT` |

#### DG_590 — 2 members
- **Sources:** `SALES_ORDER_PERIOD, SALES_ORDER_PERIOD1, SALES_ORDER_PERIOD_XREF, SALES_ORDER_PERIOD_XREF1`
- **Targets:** `PARAMETER_FILE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SALES_PERIOD_DATES | 2 | 7784 | 9 | `s_m_CALCULATE_SALES_PERIOD_DATES` |
| 2 | sales_period_dates | 2 | 8626 | 9 | `s_m_opp_calculate_sales_period_dates` |

#### DG_591 — 2 members
- **Sources:** `DUMMY_SRCE`
- **Targets:** `DUMMY_TGT12`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SAM_EMEA_WEEKLY | 1 | 487 | 5 | `s_m_Check_App_Control_Status_SAM_EMEA_WEEKLY` |
| 2 | Status_SAM_WEEKLY | 1 | 491 | 5 | `s_m_Check_App_Control_Status_SAM_WEEKLY` |

#### DG_592 — 2 members
- **Sources:** `CUST_SEG_INCR_MARGIN, CUST_SEG_INCR_MARGIN_SRC_OFFNET, CUST_SEG_INCR_MARGIN_SRC_ONNET, CUST_SEG_INCR_MARGIN_TGT`
- **Targets:** `CUST_SEG_INCR_MARGIN, DSL_MARGIN`
- **Lookups:** `CUSTOMER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SEG_INCR_MARGIN | 21 | 10801 | 15 | `s_m_Load_CUST_SEG_INCR_MARGIN` |
| 2 | INCR_MARGIN_OneTimeLoad | 21 | 10802 | 15 | `s_m_Load_CUST_SEG_INCR_MARGIN_OneTimeLoad` |

#### DG_593 — 2 members
- **Sources:** `ECCKT_CUST_SERV_REV_HIST`
- **Targets:** `DSL_MARGIN, SERVICE_ENDPNT_MARGIN`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SERVICE_ENDPNT_MARGIN | 9 | 9724 | 3 | `s_m_Update_SERVICE_ENDPNT_MARGIN` |
| 2 | ENDPNT_MARGIN_OneTimeLoad | 9 | 9725 | 3 | `s_m_Update_SERVICE_ENDPNT_MARGIN_OneTimeLoad` |

#### DG_594 — 2 members
- **Sources:** `SERVICE_ENDPNT_MARGIN, SERVICE_ENDPNT_MARGIN_SRC_0_BILLERS, SERVICE_ENDPNT_MARGIN_SRC_OFFNET, SERVICE_ENDPNT_MARGIN_SRC_ONNET, SERVICE_ENDPNT_MARGIN_TGT_0_BILLERS +3 more`
- **Targets:** `DSL_MARGIN, SERVICE_ENDPNT_MARGIN`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, F_REVENUE_DETAIL_ALL, GL_CUSTOMER_SEGMENT, GL_SEG1_COMPANY, SUPPLIER_CIRCUIT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SERVICE_ENDPNT_MARGIN | 19 | 10666 | 42 | `s_m_Load_SERVICE_ENDPNT_MARGIN` |
| 2 | ENDPNT_MARGIN_OneTimeLoad | 19 | 10667 | 42 | `s_m_Load_SERVICE_ENDPNT_MARGIN_OneTimeLoad` |

#### DG_595 — 2 members
- **Sources:** `SERVICE_INCR_MARGIN, SERVICE_INCR_MARGIN_KEY_ID_OFFNET, SERVICE_INCR_MARGIN_SRC_OFFNET, SERVICE_INCR_MARGIN_SRC_ONNET, SERVICE_INCR_MARGIN_TGT_DELETE +3 more`
- **Targets:** `DSL_MARGIN, SERVICE_INCR_MARGIN`
- **Lookups:** `SERVICE_INCR_MARGIN`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SERVICE_INCR_MARGIN | 1 | 4964 | 31 | `s_m_Load_SERVICE_INCR_MARGIN` |
| 2 | INCR_MARGIN_OneTimeLoad | 1 | 4965 | 31 | `s_m_Load_SERVICE_INCR_MARGIN_OneTimeLoad` |

#### DG_596 — 2 members
- **Sources:** `SERVICE_LOOKUP`
- **Targets:** `CERM, SERVICE_LOOKUP`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SERVICE_LOOKUP_VW | 1 | 6758 | 2 | `s_m_Refresh_SERVICE_LOOKUP_VW` |
| 2 | Update_SERVICE_LOOKUP | 1 | 7030 | 5 | `s_m_Update_SERVICE_LOOKUP` |

#### DG_597 — 2 members
- **Sources:** `ORDER_RELATIONSHIP, SERV_DLVRY_RELATIONSHIP`
- **Targets:** `SERV_DLVRY_RELATIONSHIP`
- **Lookups:** `SERV_DLVRY_PRODUCT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SERV_DLVRY_RELATIONSHIP | 32 | 12413 | 10 | `s_m_Load_SERV_DLVRY_RELATIONSHIP` |
| 2 | DLVRY_RELATIONSHIP_ORACLE2E | 32 | 12415 | 10 | `s_m_Load_SERV_DLVRY_RELATIONSHIP_ORACLE2E` |

#### DG_598 — 2 members
- **Sources:** `AE2E_ENDSTATE_GRANITE_PREP, AE2E_ENDSTATE_GRANITE_PREP1, AE2E_ENDSTATE_GRANITE_PREP2, AE2E_ENDSTATE_GRANITE_PREP3, AE2E_ENDSTATE_GRANITE_PREP4 +7 more`
- **Targets:** `AE2E_ENDSTATE_SIEBEL_PREP, AE2E_JOB_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SIEBEL_DIS_PREP | 4 | 9033 | 22 | `s_m_AE2E_UNITY_SIEBEL_DIS_PREP` |
| 2 | CUSINS_SIEBEL_PREP | 4 | 9068 | 22 | `s_m_Load_AE2E_UNITY_CUSINS_SIEBEL_PREP` |

#### DG_599 — 2 members
- **Sources:** `ADDRESS_XREF`
- **Targets:** `ADDRESS_XREF, DSL_UNT_PRD_ACTY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SITE_ID_1 | 1 | 7629 | 3 | `s_m_update_ADDRESS_XREF_SITE_ID_1` |
| 2 | SITE_ID_2 | 1 | 7630 | 3 | `s_m_update_ADDRESS_XREF_SITE_ID_2` |

#### DG_600 — 2 members
- **Sources:** `TRAIL_SOURCE_ATTR`
- **Targets:** `CODS_NETINV, TRAIL_SOURCE_ATTR`
- **Lookups:** `TRAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SOURCE_ATTR_ARM | 33 | 12518 | 10 | `s_m_Load_TRAIL_SOURCE_ATTR_ARM` |
| 2 | ATTR_AMDOCS_RM | 33 | 12546 | 10 | `s_m_load_TRAIL_SOURCE_ATTR_AMDOCS_RM` |

#### DG_601 — 2 members
- **Sources:** `CDI_CIRCUIT, TRAIL_SOURCE_ATTR`
- **Targets:** `CODS_NETINV, TRAIL_SOURCE_ATTR`
- **Lookups:** `TRAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SOURCE_ATTR_GRANITE | 33 | 12519 | 11 | `s_m_Load_TRAIL_SOURCE_ATTR_GRANITE` |
| 2 | SOURCE_ATTR_RSI | 33 | 12521 | 12 | `s_m_Load_TRAIL_SOURCE_ATTR_RSI` |

#### DG_602 — 2 members
- **Sources:** `CDW_LOAD_RULE, CMF, SOURCE_BILLING_ACCOUNT, SOURCE_BILLING_ACCOUNT3`
- **Targets:** `CODS, SOURCE_BILLING_ACCOUNT`
- **Lookups:** `BILLING_ACCOUNT, CMF, COUNTRY, CUSTOMER, CUSTOMER_ID_ACCT_MAP +4 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SOURCE_BILLING_ACCOUNT | 9 | 9622 | 23 | `s_m_LOAD_IDC_KENAN_SOURCE_BILLING_ACCOUNT` |
| 2 | SOURCE_BILLING_ACCOUNT | 12 | 10000 | 23 | `s_m_Load_KENANFX_SOURCE_BILLING_ACCOUNT` |

#### DG_603 — 2 members
- **Sources:** `SOURCE_CONTACT_ROLE`
- **Targets:** `CODS, SOURCE_CONTACT_ROLE`
- **Lookups:** `CUSTOMER_ORDER, CUSTOMER_ORDER_PRODUCT, LKP_CUSTOMER_ORDER, ORDER_PRODUCT_COMPNT, SOURCE_CONTACT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SOURCE_CONTACT_ROLE | 23 | 11153 | 10 | `s_m_Load_ORACLE2E_SOURCE_CONTACT_ROLE` |
| 2 | SOURCE_CONTACT_ROLE | 23 | 11166 | 9 | `s_m_Load_QF_SOURCE_CONTACT_ROLE` |

#### DG_604 — 2 members
- **Sources:** `SPAN, SPAN_DEL, SPAN_SECTION, SPAN_SECTION_DEL`
- **Targets:** `CODS_NETINV, SPAN_SECTION`
- **Lookups:** `PHYS_STRUCT, SPAN_SECTION`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SPAN_SECTION_SPAN | 29 | 11920 | 13 | `s_m_Load_SPAN_SECTION_SPAN` |
| 2 | SECTION_SPAN_UNIT | 29 | 11921 | 13 | `s_m_Load_SPAN_SECTION_SPAN_UNIT` |

#### DG_605 — 2 members
- **Sources:** `M_SSAS_PARTITION_LOG`
- **Targets:** `FF_DUMMY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SSAS_Generate_Parameters | 2 | 8462 | 5 | `s_m_SSAS_Generate_Parameters` |
| 2 | Generate_Parameters_Hist | 2 | 8463 | 6 | `s_m_SSAS_Generate_Parameters_Hist` |

#### DG_606 — 2 members
- **Sources:** `PROCESS_REQUEST, STANDALONE_PROCESS_REQUEST`
- **Targets:** `STANDALONE_PROCESS_REQUEST`
- **Lookups:** `APPLICATION_PROCESS, CRITICAL_DATES, L4_QS_SWAT_CHANGE_VIEW, L4_QS_TPC_NET_ADV_DISCO_VIEW, PROCESS +3 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STANDALONE_PROCESS_REQUEST | 26 | 11527 | 18 | `s_m_Load_STANDALONE_PROCESS_REQUEST` |
| 2 | PROCESS_REQUEST_NRT | 26 | 11528 | 18 | `s_m_Load_STANDALONE_PROCESS_REQUEST_NRT` |

#### DG_607 — 2 members
- **Sources:** `STG_TOPOLOGY, TOPOLOGY`
- **Targets:** `ASLNTFLX, TOPOLOGY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STG_TO_TOPOLOGY | 2 | 8171 | 11 | `s_m_Load_NETFLEX_STG_TO_TOPOLOGY` |
| 2 | TO_TOPOLOGY_DAILY | 2 | 8172 | 11 | `s_m_Load_NETFLEX_STG_TO_TOPOLOGY_DAILY` |

#### DG_608 — 2 members
- **Sources:** `PHYS_STRUCT, PHYS_STRUCT1, SITE`
- **Targets:** `CODS_NETINV, PHYS_STRUCT`
- **Lookups:** `CLONES_NET_SITE_DEF, GL_BUSINESS_AREA, GL_SEG2_PROFIT_CTR, PHYS_STRUCT, PHYS_STRUCT_GEOCODE +1 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | STRUCT_GLM_BUILDING | 24 | 11267 | 20 | `s_m_Load_PHYS_STRUCT_GLM_BUILDING` |
| 2 | STRUCT_RSI_FRAB | 26 | 11496 | 20 | `s_m_Load_PHYS_STRUCT_RSI_FRAB` |

#### DG_609 — 2 members
- **Sources:** `ASL_SYNCHRONOSS, CIRCUIT_DETAIL, SUPPLIER, SUPPLIER_CIRCUIT`
- **Targets:** `CODS_NETEX, DUMMY_TARGET, SUPPLIER_CIRCUIT`
- **Lookups:** `CIRCUIT_CHARGE_DETAIL, CIRCUIT_DETAIL, CO_LOCATION, CUSTOMER, SUPPLIER_BILLING_ACCOUNT +3 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SUPPLIER_CIRCUIT_SAM | 17 | 10503 | 17 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_SAM` |
| 2 | CIRCUIT_SAM_EMEA | 17 | 10504 | 17 | `s_m_Load_NETEX_SUPPLIER_CIRCUIT_SAM_EMEA` |

#### DG_610 — 2 members
- **Sources:** `SUPPLIER_CIRCUIT, SUPPLIER_CIRCUIT2, SUPPLIER_INV_DETAIL`
- **Targets:** `CODS_NETEX, SUPPLIER_CIRCUIT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SUPPLIER_CIRCUIT_SAM | 21 | 10935 | 8 | `s_m_Upd_NETEX_SUPPLIER_CIRCUIT_SAM` |
| 2 | CIRCUIT_SAM_EMEA | 21 | 10936 | 8 | `s_m_Upd_NETEX_SUPPLIER_CIRCUIT_SAM_EMEA` |

#### DG_611 — 2 members
- **Sources:** `ASL_SYNCHRONOSS, INVOICE_MAIN, SUPPLIER_INVOICE, SUPPLIER_INVOICE1`
- **Targets:** `DUMMY_TARGET, SUPPLIER_INVOICE`
- **Lookups:** `CCF_INV_PMT_DTLS, CURRENCY_EXCHANGE_RATE, INVOICE_MAIN, INVOICE_STATE, SUPPLIER_BILLING_ACCOUNT +1 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SUPPLIER_INVOICE_SAM | 16 | 10378 | 20 | `s_m_Load_NETEX_SUPPLIER_INVOICE_SAM` |
| 2 | INVOICE_SAM_EMEA | 16 | 10379 | 16 | `s_m_Load_NETEX_SUPPLIER_INVOICE_SAM_EMEA` |

#### DG_612 — 2 members
- **Sources:** `SUPPLIER_LOCATION, VENDOR_REMIT`
- **Targets:** `CODS_NETEX, SUPPLIER_LOCATION`
- **Lookups:** `AP_VENDOR_LOCATION, SUPPLIER, VENDOR`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SUPPLIER_LOCATION_SAM | 11 | 9883 | 10 | `s_m_Load_NETEX_SUPPLIER_LOCATION_SAM` |
| 2 | LOCATION_SAM_LATAM | 11 | 9885 | 10 | `s_m_Load_NETEX_SUPPLIER_LOCATION_SAM_LATAM` |

#### DG_613 — 2 members
- **Sources:** `TID, WAVELENGTH_CLIENT`
- **Targets:** `TID_ALL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | SVCID_FILE_LOAD | 3 | 8932 | 1 | `s_m_Load_SVCID_FILE_LOAD` |
| 2 | FILE_LOAD_DAILY | 3 | 8933 | 1 | `s_m_Load_SVCID_FILE_LOAD_DAILY` |

#### DG_614 — 2 members
- **Sources:** `ACCRUAL_CHARGE_MJE_EXPORT_SAP, ACCRUAL_CHARGE_MJE_EXPORT_SAP1`
- **Targets:** `SAP_ACCRUAL_CHARGE_MJE_EXPORT_FF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TAILS_EXPORT_FF | 27 | 11574 | 2 | `s_m_Load_EMEA_NETEX_ALLOC_TAILS_EXPORT_FF` |
| 2 | TAILS_EXPORT_FF | 27 | 11599 | 4 | `s_m_Load_SAP_NETEX_ALLOC_TAILS_EXPORT_FF` |

#### DG_615 — 2 members
- **Sources:** `F_TAXES_BILLED_STG, F_TAXES_BILLED_STG1`
- **Targets:** `FF_LOAD_STATUS, LEGACY_CTL_BILLING_STG, TAXMART_STG`
- **Lookups:** `D_TAXMART_PERIOD, TAX_GEOCODES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TAXES_BILLED_STG | 12 | 9983 | 7 | `s_m_Load_ENS_F_TAXES_BILLED_STG` |
| 2 | TAXES_BILLED_STG | 12 | 9989 | 7 | `s_m_Load_F_TAXES_BILLED_STG` |

#### DG_616 — 2 members
- **Sources:** `BILL_INVOICE, BILL_INVOICE_DETAIL, BILL_INVOICE_TAX, RATE_CURRENCY_VALUES, TAX_PKG_INST_ID_VALUES`
- **Targets:** `INVOICE_ITEM_TAX`
- **Lookups:** `CURRENCY_EXCHANGE_RATE, INVOICE_ITEM, INVOICE_ITEM_TAX, TAX_CODES_COMM, TAX_TYPE_COMM_VALUES`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TAX_IDC_KENAN | 18 | 10576 | 10 | `s_m_Load_INVOICE_ITEM_TAX_IDC_KENAN` |
| 2 | IDC_KENAN_HISTORICAL | 18 | 10577 | 10 | `s_m_Load_INVOICE_ITEM_TAX_IDC_KENAN_HISTORICAL` |

#### DG_617 — 2 members
- **Sources:** `PRODUCT_ELEMENTS, TAX_LOCATION_RULES`
- **Targets:** `TAX_LOCATION_RULES`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TAX_LOCATION_RULES | 2 | 7898 | 2 | `s_m_LOAD_CDC_TAX_LOCATION_RULES` |
| 2 | TAX_LOCATION_RULES | 2 | 7929 | 3 | `s_m_LOAD_TAX_LOCATION_RULES` |

#### DG_618 — 2 members
- **Sources:** `INVOICE, SUPPLIER_INV_DETAIL, SUPPLIER_INV_DETAIL11, TAX_SURCHARGE_DETAIL`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_BILLING_ACCOUNT, SUPPLIER_CIRCUIT, SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TAX_SRG_REG | 20 | 10752 | 18 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_TAX_SRG_REG` |
| 2 | SRG_REG_CTL | 20 | 10753 | 18 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_TAX_SRG_REG_CTL` |

#### DG_619 — 2 members
- **Sources:** `F_RAW_TG_STATS, F_RAW_TG_STATS1, W_SONUS_TG_STATS`
- **Targets:** `F_RAW_TG_STATS`
- **Lookups:** `D_CLNDR, D_SWITCH, D_TRUNKGROUP`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TG_STATS_SONUS | 17 | 10485 | 7 | `s_m_Load_F_RAW_TG_STATS_SONUS` |
| 2 | STATS_SONUS_SBC7K | 17 | 10486 | 7 | `s_m_Load_F_RAW_TG_STATS_SONUS_SBC7K` |

#### DG_620 — 2 members
- **Sources:** `BILLING_ACCOUNT, CMF, F_BILLING_ROLLUP, F_BILLING_ROLLUPREV_FLAG_NOT_A, F_BILLING_ROLLUP_INSTALLMENT_INV +4 more`
- **Targets:** `TMP_F_GAAP_REVENUE, TMP_F_GAAP_REVENUE_KENANFX`
- **Lookups:** `CMF, CMF_NOTES, DH_GL_ACCOUNT, DH_GL_BUSINESS_AREA, DH_GL_COMPANY +17 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | THREAD_1_4 | 24 | 11204 | 108 | `s_m_LOAD_TMP_F_GAAP_REVENUE_TAXMART_THREAD_1_4` |
| 2 | THREAD_5_8 | 24 | 11205 | 108 | `s_m_LOAD_TMP_F_GAAP_REVENUE_TAXMART_THREAD_5_8` |

#### DG_621 — 2 members
- **Sources:** `SUBSCRIBER_LINE`
- **Targets:** `TN_SERVICE_IMAGE`
- **Lookups:** `ADDRESS`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TIME_ADDRESS_UPDATE | 2 | 7924 | 6 | `s_m_LOAD_SLDB_TN_SERVICE_IMAGE_ONE_TIME_ADDRESS_UPDATE` |
| 2 | ONE_TIME_UPDATE | 2 | 7925 | 6 | `s_m_LOAD_SLDB_TN_SERVICE_IMAGE_ONE_TIME_UPDATE` |

#### DG_622 — 2 members
- **Sources:** `TRAIL`
- **Targets:** `ODS_TIRKS_DATA_VALIDATION_FF`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TIRKS_Data_Validation | 33 | 12490 | 2 | `s_m_Load_ODS_TIRKS_Data_Validation` |
| 2 | TIRKS_Data_Validation | 33 | 12523 | 2 | `s_m_Load_TRAIL_STG_TIRKS_Data_Validation` |

#### DG_623 — 2 members
- **Sources:** `DUMMY_SRCE`
- **Targets:** `APP_CONTROL_STATUS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TIRKS_Dummy_mon | 1 | 7065 | 2 | `s_m_check_app_Control_Status_STAGE_TIRKS_Dummy_mon` |
| 2 | TIRKS_Dummy_sun | 1 | 7066 | 2 | `s_m_check_app_Control_Status_STAGE_TIRKS_Dummy_sun` |

#### DG_624 — 2 members
- **Sources:** `TN_DISCONNECT, TN_SERVICE_IMAGE`
- **Targets:** `CODS_TN, TN_DISCONNECT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TNI_TN_DISCONNECT | 31 | 12326 | 16 | `s_m_Load_TNI_TN_DISCONNECT` |
| 2 | Load_TN_DISCONNECT | 31 | 12327 | 16 | `s_m_Load_TN_DISCONNECT` |

#### DG_625 — 2 members
- **Sources:** `D_CONSUMP_STATUS, D_CUST, D_PROD, R_TN`
- **Targets:** `AZURE_TN_NUMS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TN_NUMS_File | 34 | 12590 | 2 | `s_m_Generate_AZURE_TN_NUMS_File` |
| 2 | AZURE_TN_NUMS | 34 | 12594 | 2 | `s_m_LOAD_AZURE_TN_NUMS` |

#### DG_626 — 2 members
- **Sources:** `MANAGED_ELEMENT, STG_MANAGED_ELEMENT`
- **Targets:** `ASLNTFLX, MANAGED_ELEMENT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TO_MANAGED_ELEMENT | 2 | 8617 | 11 | `s_m_load_STG_TO_MANAGED_ELEMENT` |
| 2 | MANAGED_ELEMENT_DAILY | 2 | 8618 | 11 | `s_m_load_STG_TO_MANAGED_ELEMENT_DAILY` |

#### DG_627 — 2 members
- **Sources:** `OCH_CRS, STG_OCH_CRS`
- **Targets:** `ASLNTFLX, OCH_CRS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TO_OCH_CRS | 2 | 8167 | 11 | `s_m_Load_NETFLEX_STG_TO_OCH_CRS` |
| 2 | OCH_CRS_DAILY | 2 | 8168 | 11 | `s_m_Load_NETFLEX_STG_TO_OCH_CRS_DAILY` |

#### DG_628 — 2 members
- **Sources:** `ODU_CRS, STG_ODU_CRS`
- **Targets:** `ASLNTFLX, ODU_CRS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TO_ODU_CRS | 2 | 8169 | 11 | `s_m_Load_NETFLEX_STG_TO_ODU_CRS` |
| 2 | ODU_CRS_DAILY | 2 | 8170 | 11 | `s_m_Load_NETFLEX_STG_TO_ODU_CRS_DAILY` |

#### DG_629 — 2 members
- **Sources:** `OFFNET_MATCH, OFFNET_MATCH1`
- **Targets:** `OFFNET_MATCH, OFFNET_MATCH_REASON`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TO_ORDER_HOP2 | 1 | 7497 | 13 | `s_m_load_OFFNET_MATCH_REASON_ASR_TO_ORDER_HOP2` |
| 2 | TO_NETEX_HOP2 | 1 | 7498 | 13 | `s_m_load_OFFNET_MATCH_REASON_ORDER_TO_NETEX_HOP2` |

#### DG_630 — 2 members
- **Sources:** `STG_WAVELENGTH_CLIENT, WAVELENGTH_CLIENT`
- **Targets:** `ASLNTFLX, WAVELENGTH_CLIENT`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TO_WAVELENGTH_CLIENT | 2 | 8175 | 11 | `s_m_Load_NETFLEX_STG_TO_WAVELENGTH_CLIENT` |
| 2 | WAVELENGTH_CLIENT_DAILY | 2 | 8176 | 11 | `s_m_Load_NETFLEX_STG_TO_WAVELENGTH_CLIENT_DAILY` |

#### DG_631 — 2 members
- **Sources:** `LIMS_PORT, TRAIL_COMPONENT`
- **Targets:** `CODS_NETINV, TRAIL_COMPONENT`
- **Lookups:** `SOURCE_TRAIL, TRAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TRAIL_COMPONENT_CORE | 33 | 12544 | 10 | `s_m_load_TRAIL_COMPONENT_CORE` |
| 2 | TRAIL_COMPONENT_LIMS | 33 | 12545 | 10 | `s_m_load_TRAIL_COMPONENT_LIMS` |

#### DG_632 — 2 members
- **Sources:** `CIRCUIT, TRANSPORT_TRAIL`
- **Targets:** `CODS_NETINV, TRANSPORT_TRAIL`
- **Lookups:** `TRAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TRANSPORT_TRAIL_ARM | 33 | 12526 | 10 | `s_m_Load_TRANSPORT_TRAIL_ARM` |
| 2 | TRANSPORT_TRAIL_LIMS | 33 | 12528 | 10 | `s_m_Load_TRANSPORT_TRAIL_LIMS` |

#### DG_633 — 2 members
- **Sources:** `CDI_CIRCUIT, TRANSPORT_TRAIL, TRANSPORT_TRAIL1`
- **Targets:** `CODS_NETINV, TRANSPORT_TRAIL`
- **Lookups:** `TRAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TRANSPORT_TRAIL_RSI | 33 | 12530 | 10 | `s_m_Load_TRANSPORT_TRAIL_RSI` |
| 2 | TRAIL_RSI_SL | 33 | 12531 | 10 | `s_m_Load_TRANSPORT_TRAIL_RSI_SL` |

#### DG_634 — 2 members
- **Sources:** `PARENT_TRANS_JEOP_CODE, PARENT_TRANS_JEOP_CODE12, PARENT_TRANS_JEOP_CODE31, PARENT_TRANS_JEOP_CODE311`
- **Targets:** `DRIVING_KEY1, FF_LOAD_STATUS, PARENT_TRANS_JEOP_CODE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TRANS_JEOP_CODE | 1 | 4026 | 15 | `s_m_Load_PARENT_TRANS_JEOP_CODE` |
| 2 | JEOP_CODE_HIST | 1 | 4027 | 15 | `s_m_Load_PARENT_TRANS_JEOP_CODE_HIST` |

#### DG_635 — 2 members
- **Sources:** `PARENT_TRANS_STATUS_TAB, PARENT_TRANS_STATUS_TAB1, PARENT_TRANS_STATUS_TAB4`
- **Targets:** `DRIVING_KEY1, FF_LOAD_STATUS, PARENT_TRANS_STATUS_TAB`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TRANS_STATUS_TAB | 1 | 4028 | 15 | `s_m_Load_PARENT_TRANS_STATUS_TAB` |
| 2 | STATUS_TAB_hist | 1 | 4029 | 15 | `s_m_Load_PARENT_TRANS_STATUS_TAB_hist` |

#### DG_636 — 2 members
- **Sources:** `LINE_ITEM, LINE_ITEM_DTL, LINE_ITEM_JUR_DTL, USOC_BILLED`
- **Targets:** `USOC_BILLED`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL, VVREF`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TYPE_ACCT_Incremental | 21 | 10857 | 13 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_ACCT_Incremental` |
| 2 | ACCT_Incremental_CTL | 21 | 10858 | 13 | `s_m_Load_NETEX_USOC_BILLED_CHARGE_TYPE_ACCT_Incremental_CTL` |

#### DG_637 — 2 members
- **Sources:** `NETEX_ACCRUAL_ALLOC`
- **Targets:** `DSL_AIM, NETEX_ACCRUAL_ALLOC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Tails_Default_Currencies | 1 | 3705 | 12 | `s_m_Load_Netex_Alloc_Percentage_Tails_Default_Currencies` |
| 2 | Tails_Unmatched_Accounts | 1 | 3706 | 5 | `s_m_Load_Netex_Percentage_Tails_Unmatched_Accounts` |

#### DG_638 — 2 members
- **Sources:** `FILELIST, FILELIST_O_SOURCE`
- **Targets:** `FILELIST_TARGET`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Term_Recosted_files | 1 | 550 | 6 | `s_m_Check_Paired_Orig_Term_Recosted_files` |
| 2 | Orig_Term_files | 1 | 551 | 6 | `s_m_Check_Paired_Orig_Term_files` |

#### DG_639 — 2 members
- **Sources:** `PROCESS_PARAMETER`
- **Targets:** `FF_PAST_DUE_INVOICES_PARAM_FILES`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Tickets_Param_File | 16 | 10277 | 3 | `s_m_Generate_Billing_Tickets_Param_File` |
| 2 | Invoices_Param_File | 16 | 10278 | 3 | `s_m_Generate_Past_Due_Invoices_Param_File` |

#### DG_640 — 2 members
- **Sources:** `DUMMY`
- **Targets:** `JOB_STATUS_LOG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | TimedOut_Recovery_Green | 3 | 8714 | 3 | `s_m_Adjust_Paramfile_TimedOut_Recovery_Green` |
| 2 | TimedOut_Recovery_Red | 3 | 8715 | 3 | `s_m_Adjust_Paramfile_TimedOut_Recovery_Red` |

#### DG_641 — 2 members
- **Sources:** `TRANSPORT_TRAIL`
- **Targets:** `TRANSPORT_TRAIL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | Truncate_STG_TABLES | 1 | 6841 | 1 | `s_m_Truncate_STG_TABLES` |
| 2 | PHYS_STRUCT_TABLE | 1 | 7618 | 1 | `s_m_truncate_PHYS_STRUCT_TABLE` |

#### DG_642 — 2 members
- **Sources:** `ULTIMATE_SUPPLIER, VENDOR`
- **Targets:** `CODS_NETEX, ULTIMATE_SUPPLIER`
- **Lookups:** `SUPPLIER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ULTIMATE_SUPPLIER_SAM | 10 | 9799 | 10 | `s_m_Load_NETEX_ULTIMATE_SUPPLIER_SAM` |
| 2 | SUPPLIER_SAM_LATAM | 10 | 9801 | 10 | `s_m_Load_NETEX_ULTIMATE_SUPPLIER_SAM_LATAM` |

#### DG_643 — 2 members
- **Sources:** `DUAL`
- **Targets:** `PREV_DATE_CACHING`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | UPDATE_PRM_FILE | 30 | 12205 | 1 | `s_m_UPDATE_PRM_FILE` |
| 2 | FILE_THIRD_RUN | 30 | 12206 | 1 | `s_m_UPDATE_PRM_FILE_THIRD_RUN` |

#### DG_644 — 2 members
- **Sources:** `SUPPLIER_INV_DETAIL, USAGE_DETAIL`
- **Targets:** `CODS_NETEX, SUPPLIER_INV_DETAIL`
- **Lookups:** `SUPPLIER_INVOICE, SUPPLIER_INV_DETAIL`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | USAGE_SAM_EMEA | 20 | 10760 | 9 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_USAGE_SAM_EMEA` |
| 2 | USAGE_SAM_LATAM | 20 | 10762 | 10 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_USAGE_SAM_LATAM` |

#### DG_645 — 2 members
- **Sources:** `USOC_BILLED`
- **Targets:** `USOC_BILLED_FLATFILE`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | USOC_BILLED_Flatfile | 25 | 11400 | 2 | `s_m_Load_NETEX_USOC_BILLED_Flatfile` |
| 2 | BILLED_Flatfile_CTL | 25 | 11401 | 2 | `s_m_Load_NETEX_USOC_BILLED_Flatfile_CTL` |

#### DG_646 — 2 members
- **Sources:** `W_CUST_UTIL_NOTIFY`
- **Targets:** `W_CUST_UTIL_NOTIFY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | UTIL_NOTIFY_Reset | 1 | 7045 | 5 | `s_m_Update_W_CUST_UTIL_NOTIFY_Reset` |
| 2 | UTIL_NOTIFY_Retest | 1 | 7046 | 5 | `s_m_Update_W_CUST_UTIL_NOTIFY_Retest` |

#### DG_647 — 2 members
- **Sources:** `W_TG_UTIL_NOTIFY`
- **Targets:** `W_TG_UTIL_NOTIFY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | UTIL_NOTIFY_Reset | 1 | 7047 | 5 | `s_m_Update_W_TG_UTIL_NOTIFY_Reset` |
| 2 | UTIL_NOTIFY_Retest | 1 | 7048 | 5 | `s_m_Update_W_TG_UTIL_NOTIFY_Retest` |

#### DG_648 — 2 members
- **Sources:** `ASL_SYNCHRONOSS, SUPPLIER_INV_DETAIL`
- **Targets:** `DUMMY_TARGET`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | VALIDATION_EMEA_Weekly | 24 | 11232 | 6 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_COUNT_VALIDATION_EMEA_Weekly` |
| 2 | COUNT_VALIDATION_Weekly | 24 | 11233 | 6 | `s_m_Load_NETEX_SUPPLIER_INV_DETAIL_COUNT_VALIDATION_Weekly` |

#### DG_649 — 2 members
- **Sources:** `BAN_VENDOR_LISTING, BAN_VENDOR_LISTING11, SUPPLIER_BILLING_ACCOUNT, SUPPLIER_BILLING_ACCOUNT1`
- **Targets:** `BAN_VENDOR_LISTING, DUMMY_TARGET`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | VENDOR_LISTING_SAM | 13 | 10040 | 19 | `s_m_Load_BAN_VENDOR_LISTING_SAM` |
| 2 | LISTING_SAM_LATAM | 13 | 10041 | 19 | `s_m_Load_BAN_VENDOR_LISTING_SAM_LATAM` |

#### DG_650 — 2 members
- **Sources:** `X_VPOL_PROCESS_CONTROL`
- **Targets:** `FF_VPOL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | VPOL_Missing_Partitions | 8 | 9591 | 2 | `s_m_VPOL_Missing_Partitions` |
| 2 | More_Days_YN | 8 | 9592 | 2 | `s_m_VPOL_More_Days_YN` |

#### DG_651 — 2 members
- **Sources:** `FF_VPOL_DUMMY_SOURCE`
- **Targets:** `X_VPOL_PROCESS_CONTROL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | VPOL_Upd_Post | 1 | 7054 | 3 | `s_m_VPOL_Upd_Post` |
| 2 | VPOL_Upd_Pre | 1 | 7055 | 3 | `s_m_VPOL_Upd_Pre` |

#### DG_652 — 2 members
- **Sources:** `STG_WAVELENGTH_HIERARCHY, TGT_SRC_WAVELENGTH_HIERARCHY21, WAVELENGTH_HIERARCHY`
- **Targets:** `ASLNTFLX, WAVELENGTH_HIERARCHY, WAVELENGTH_HIERARCHY2`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | WAVELENGTH_HIERARCHY_DAILY | 2 | 8177 | 11 | `s_m_Load_NETFLEX_STG_TO_WAVELENGTH_HIERARCHY_DAILY` |
| 2 | NETFLEX_WAVELENGTH_HIERARCHY | 2 | 8178 | 11 | `s_m_Load_NETFLEX_WAVELENGTH_HIERARCHY` |

#### DG_653 — 2 members
- **Sources:** `STG_WAVELENGTH_HIERARCHY_SVC, WAVELENGTH_HIERARCHY_SVC`
- **Targets:** `ASLNTFLX, WAVELENGTH_HIERARCHY_SVC`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | WAVELENGTH_HIERARCHY_SVC | 2 | 8179 | 11 | `s_m_Load_NETFLEX_WAVELENGTH_HIERARCHY_SVC` |
| 2 | HIERARCHY_SVC_DAILY | 2 | 8180 | 11 | `s_m_Load_NETFLEX_WAVELENGTH_HIERARCHY_SVC_DAILY` |

#### DG_654 — 2 members
- **Sources:** `TABLE_RESRCH_LOG, TABLE_RESRCH_LOG1`
- **Targets:** `DSL_SM, FF_LOAD_STATUS_START_TIME, W_CASE_RESEARCH`
- **Lookups:** `W_CASE_RESEARCH`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | W_CASE_RESEARCH | 2 | 8439 | 9 | `s_m_Load_W_CASE_RESEARCH` |
| 2 | CASE_RESERCH_OTS | 2 | 8440 | 9 | `s_m_Load_W_CASE_RESERCH_OTS` |

#### DG_655 — 2 members
- **Sources:** `AE2E_BROADWING_STG, AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG`
- **Targets:** `AE2E_JOB_LOG, AE2E_UNIX_JOB_LOG, AE2E_XLINK_CV_PREP`
- **Lookups:** `AE2E_SYSTEM`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | XLINK_CV_PREP | 7 | 9458 | 7 | `s_m_LOAD_AE2E_BRDINSTALL_XLINK_CV_PREP` |
| 2 | XLINK_CV_PREP | 7 | 9459 | 7 | `s_m_LOAD_AE2E_BRD_DISCO_XLINK_CV_PREP` |

#### DG_656 — 2 members
- **Sources:** `F_PRODUCT_ACTIVITY, ORDERS`
- **Targets:** `DSL_UNT_PRD_ACTY, F_PRODUCT_ACTIVITY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ZUORA_Ord_Details | 15 | 10267 | 6 | `s_m_Update_F_PRODUCT_ACTIVITY_ZUORA_Ord_Details` |
| 2 | Ord_Sales_Details | 15 | 10268 | 6 | `s_m_Update_F_PRODUCT_ACTIVITY_ZUORA_Ord_Sales_Details` |

#### DG_657 — 2 members
- **Sources:** `DSS_CIRCUIT`
- **Targets:** `ACTUAL_COMPLETION_TIMES`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | actual_complete_times | 35 | 12753 | 2 | `s_m_actual_complete_times` |
| 2 | actual_complete_times1 | 35 | 12754 | 2 | `s_m_actual_complete_times1` |

#### DG_658 — 2 members
- **Sources:** `TBLCIRCUITS_ALL, TBLCIRCUITS_ALL2`
- **Targets:** `TBLCIRCUITS_ALL`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | all_pending_dups | 1 | 7049 | 5 | `s_m_Update_tblcircuits_all_pending_dups` |
| 2 | all_working_dups | 1 | 7050 | 5 | `s_m_Update_tblcircuits_all_working_dups` |

#### DG_659 — 2 members
- **Sources:** `EQUIPMENT_GROUPS`
- **Targets:** `EQUIPMENT_GROUPS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ci_equipment_groups | 1 | 7090 | 1 | `s_m_ci_equipment_groups` |
| 2 | equipment_groups_Fix | 1 | 7091 | 1 | `s_m_ci_equipment_groups_Fix` |

#### DG_660 — 2 members
- **Sources:** `LINK_CONNECTIONS`
- **Targets:** `LINK_CONNECTIONS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ci_link_connections | 1 | 7104 | 1 | `s_m_ci_link_connections` |
| 2 | ci_link_connections1 | 1 | 7105 | 1 | `s_m_ci_link_connections1` |

#### DG_661 — 2 members
- **Sources:** `SNCS`
- **Targets:** `SNCS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ci_sncs | 1 | 7141 | 1 | `s_m_ci_sncs` |
| 2 | ci_sncs1 | 1 | 7142 | 1 | `s_m_ci_sncs1` |

#### DG_662 — 2 members
- **Sources:** `TC_COMPONENTS`
- **Targets:** `TC_COMPONENTS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | ci_tc_components | 1 | 7149 | 1 | `s_m_ci_tc_components` |
| 2 | ci_tc_components1 | 1 | 7150 | 1 | `s_m_ci_tc_components1` |

#### DG_663 — 2 members
- **Sources:** `INVOICE`
- **Targets:** `ICG_BILLTRACK_PRO_STG`
- **Lookups:** `ICG_BILLTRACK_PRO_STG`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | circuit_base_query | 15 | 10271 | 5 | `s_m_load_target_ae2e_icg_billtrackpro_circuit_base_query` |
| 2 | circuit_order_attributes | 15 | 10272 | 3 | `s_m_update_target_icg_billtrack_pro_circuit_order_attributes` |

#### DG_664 — 2 members
- **Sources:** `END_POINT_DESIGNS`
- **Targets:** `STG_DELETE_TRANSACTIONS, TRAIL_ENDPNT_DESIGN`
- **Lookups:** `ADMIN_CI_DOMAIN, TRAIL_ENDPNT_DESIGN`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | complete_compare_deletes | 5 | 9339 | 6 | `s_m_trail_endpnt_design_complete_compare_deletes` |
| 2 | endpnt_design_deletes | 5 | 9340 | 6 | `s_m_trail_endpnt_design_deletes` |

#### DG_665 — 2 members
- **Sources:** `CV_OFFNET_INTER`
- **Targets:** `CV_OFFNET_INTER`
- **Lookups:** `CV_ORDERS_AND_TRACKING`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | cv_offnet_inter | 4 | 9148 | 3 | `s_m_Load_cv_offnet_inter` |
| 2 | cv_offnet_inter1 | 4 | 9149 | 2 | `s_m_Load_cv_offnet_inter1` |

#### DG_666 — 2 members
- **Sources:** `DSS_CIRCUIT_CAPACITY, DSS_CIRCUIT_CAPACITY1`
- **Targets:** `DSS_CIRCUIT_CAPACITY`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | decommissioned_designs_cc | 1 | 7193 | 2 | `s_m_decommissioned_designs_cc` |
| 2 | deleted_designs_cc | 1 | 7196 | 2 | `s_m_deleted_designs_cc` |

#### DG_667 — 2 members
- **Sources:** `ACTVTY_JEOPARDY, DSS_ACTVTY_JEOPARDY, DSS_ACTVTY_JEOPARDY2, DSS_LAST_EXTRACT, DSS_LAST_EXTRACT1`
- **Targets:** `DSS_ACTVTY_JEOPARDY, DSS_LAST_EXTRACT`
- **Lookups:** `DSS_CIRCUIT_JOB, DSS_PHYSICAL_PORT, WORKFLOW_JOB, WORKFLOW_TASK`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | dss_activity_jeopardy | 37 | 12881 | 13 | `s_m_dss_activity_jeopardy` |
| 2 | dss_actvty_jeopardy | 37 | 12882 | 13 | `s_m_dss_actvty_jeopardy` |

#### DG_668 — 2 members
- **Sources:** `DSS_LAST_EXTRACT, DSS_LAST_EXTRACT1, TERM_POINT`
- **Targets:** `DSS_LAST_EXTRACT, DSS_PHYSICAL_PORT`
- **Lookups:** `DSS_PHYSICAL_PORT, EQUIPMENT, EQUIPMENT_TERM_POINT, LEADSET_TERMINATION_POINT, LINK_CNCT +3 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | dss_physical_port | 28 | 11790 | 13 | `s_m_dss_physical_port` |
| 2 | physical_port_misc | 28 | 11791 | 13 | `s_m_dss_physical_port_misc` |

#### DG_669 — 2 members
- **Sources:** `END_POINT_DESIGNS`
- **Targets:** `END_POINT_DESIGNS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | end_point_designs | 1 | 7087 | 1 | `s_m_ci_end_point_designs` |
| 2 | end_point_designs1 | 1 | 7088 | 1 | `s_m_ci_end_point_designs1` |

#### DG_670 — 2 members
- **Sources:** `STG_CONTACT`
- **Targets:** `LAST_EXTRACT`
- **Lookups:** `AMS_CIRCUIT`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | endpnt_li_mult | 3 | 8990 | 4 | `s_m_cache_endpnt_li_mult` |
| 2 | endpnt_parm_mult | 3 | 8992 | 4 | `s_m_cache_endpnt_parm_mult` |

#### DG_671 — 2 members
- **Sources:** `EQUIPMENT_GROUPS`
- **Targets:** `EQUIPMENT_GROUP`
- **Lookups:** `ADMIN_CI_DOMAIN, CI_DOMAIN, EQUIPMENT_GROUP, EQUIPMENT_TYPE, NETWORK_ELEMENT +1 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | equipment_group | 28 | 11796 | 13 | `s_m_equipment_group` |
| 2 | equipment_group1 | 28 | 11797 | 13 | `s_m_equipment_group1` |

#### DG_672 — 2 members
- **Sources:** `FF_DUMMY`
- **Targets:** `FF_DUMMY_PARAMETERS`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | for_Bill_Run | 19 | 10605 | 2 | `s_m_Generate_Parameters_for_Bill_Run` |
| 2 | Service_Usage_Refresh | 19 | 10612 | 3 | `s_m_Generate_Parameters_for_Service_Usage_Refresh` |

#### DG_673 — 2 members
- **Sources:** `BPRATT00`
- **Targets:** `BPRATT00`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | init_oper_BPRATT00 | 1 | 7259 | 1 | `s_m_init_oper_BPRATT00` |
| 2 | load_BPRATT00 | 1 | 7302 | 1 | `s_m_load_BPRATT00` |

#### DG_674 — 2 members
- **Sources:** `CFEVUT00`
- **Targets:** `CFEVUT00`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | init_oper_CFEVUT00 | 1 | 7269 | 1 | `s_m_init_oper_CFEVUT00` |
| 2 | load_CFEVUT00 | 1 | 7355 | 1 | `s_m_load_CFEVUT00` |

#### DG_675 — 2 members
- **Sources:** `CFITQT00`
- **Targets:** `CFITQT00`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | init_oper_CFITQT00 | 1 | 7270 | 1 | `s_m_init_oper_CFITQT00` |
| 2 | load_CFITQT00 | 1 | 7363 | 1 | `s_m_load_CFITQT00` |

#### DG_676 — 2 members
- **Sources:** `CFSCIT00`
- **Targets:** `CFSCIT00`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | init_oper_CFSCIT00 | 1 | 7281 | 1 | `s_m_init_oper_CFSCIT00` |
| 2 | load_CFSCIT00 | 1 | 7427 | 1 | `s_m_load_CFSCIT00` |

#### DG_677 — 2 members
- **Sources:** `CFVNDT00`
- **Targets:** `CFVNDT00`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | init_oper_CFVNDT00 | 1 | 7289 | 1 | `s_m_init_oper_CFVNDT00` |
| 2 | load_CFVNDT00 | 1 | 7457 | 1 | `s_m_load_CFVNDT00` |

#### DG_678 — 2 members
- **Sources:** `LINK_CONNECTIONS`
- **Targets:** `LINK_CNCT`
- **Lookups:** `ADMIN_CI_DOMAIN, CABLE_TRAIL, CI_DOMAIN, LINK_CNCT, SIGNAL_ID +3 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | link_cnct | 31 | 12362 | 24 | `s_m_link_cnct` |
| 2 | link_cnct1 | 31 | 12363 | 24 | `s_m_link_cnct1` |

#### DG_679 — 2 members
- **Sources:** `LINK_CONNECTIONS`
- **Targets:** `LINK_CONNECTIONS`
- **Lookups:** `END_POINT_DESIGNS`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | link_connections_epd | 2 | 8538 | 3 | `s_m_ci_link_connections_epd` |
| 2 | link_connections_tc | 2 | 8539 | 3 | `s_m_ci_link_connections_tc` |

#### DG_680 — 2 members
- **Sources:** `CTPS`
- **Targets:** `TERM_POINT_LOGICAL_PHYS`
- **Lookups:** `CNCT_TERM_POINT, TERM_POINT, TERM_POINT_LOGICAL_PHYS, TERM_POINT_POINTER`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | logical_physical_first | 36 | 12845 | 29 | `s_m_term_point_logical_physical_first` |
| 2 | logical_physical_second | 36 | 12846 | 29 | `s_m_term_point_logical_physical_second` |

#### DG_681 — 2 members
- **Sources:** `SALES_OPPTY_LINE_HIST`
- **Targets:** `DSL_SALES_PERIOD, RECORD_FILE, SALES_OPPTY_LINE_HIST`
- **Lookups:** `DSP_COMP_PRODUCT_FACTOR_G17, OPPORTUNITY`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | orig_oppty_nbr | 29 | 12017 | 6 | `s_m_upd_oppty_hist_orig_oppty_nbr` |
| 2 | oppty_ods_id | 29 | 12018 | 8 | `s_m_upd_oppty_hist_orig_oppty_ods_id` |

#### DG_682 — 2 members
- **Sources:** `STG_QUOTE_SOLN`
- **Targets:** `ECO_SERV_INSTANCE, SSL_METRO_STG`
- **Lookups:** `AMS_LOCALACCESSOPTIONS, DSS_OMS_ORDER, ECO_SERV_INSTANCE`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | prospect_delete | 26 | 11548 | 7 | `s_m_prospect_delete` |
| 2 | instance_li_parms | 26 | 11549 | 7 | `s_m_serv_instance_li_parms` |

#### DG_683 — 2 members
- **Sources:** `CFSBCT00`
- **Targets:** `CFSBLT00`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | set_CFSBCT00_Available | 2 | 8642 | 1 | `s_m_set_CFSBCT00_Available` |
| 2 | set_CFSBCT00_Busy | 2 | 8643 | 1 | `s_m_set_CFSBCT00_Busy` |

#### DG_684 — 2 members
- **Sources:** `SNCS`
- **Targets:** `SUB_NETWORK_CNCT`
- **Lookups:** `ADMIN_CI_DOMAIN, CABLE_TRAIL, CI_DOMAIN, LINK_CNCT, NETWORK_ELEMENT +8 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | sub_network_cnct | 33 | 12551 | 31 | `s_m_sub_network_cnct` |
| 2 | sub_network_cnct1 | 33 | 12552 | 31 | `s_m_sub_network_cnct1` |

#### DG_685 — 2 members
- **Sources:** `TC_COMPONENTS`
- **Targets:** `TANDEM_CNCT_COMPONENT`
- **Lookups:** `ADMIN_CI_DOMAIN, CABLE_TRAIL, CI_DOMAIN, LINK_CNCT, PRE_WIRE_LEADSET +4 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | tandem_cnct_component | 34 | 12705 | 13 | `s_m_tandem_cnct_component` |
| 2 | tandem_cnct_component1 | 34 | 12706 | 13 | `s_m_tandem_cnct_component1` |

#### DG_686 — 2 members
- **Sources:** `END_POINT_DESIGNS`
- **Targets:** `TRAIL_ENDPNT_DESIGN`
- **Lookups:** `ADMIN_CI_DOMAIN, CI_DOMAIN, MUX_STRUCTURE, NETWORK_ELEMENT, NODE +5 more`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | trail_endpnt_design | 33 | 12553 | 28 | `s_m_trail_endpnt_design` |
| 2 | trail_endpnt_design1 | 33 | 12554 | 28 | `s_m_trail_endpnt_design1` |

#### DG_687 — 2 members
- **Sources:** `CI_ECCKT_STG, VENDOR`
- **Targets:** `CHANGED_CIRCUIT_INVENTORY_XSD_LATEST_PROD_VERSION, CI_ECCKT_STG`
- **Lookups:** `(none)`

| # | Session Name | Tier | Step | Tx | Full Path |
|---|-------------|------|------|----|-----------|
| 1 | xml_btp_custom | 11 | 9903 | 8 | `s_m_Load_xml_btp_custom` |
| 2 | btp_custom_LATAM2 | 11 | 9904 | 8 | `s_m_Load_xml_btp_custom_LATAM2` |

---

*Generated by V11 Complexity Analyzer + Fingerprint Deduplication Engine — ETL Dependency Visualizer*