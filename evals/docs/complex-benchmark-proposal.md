# Next comparison: Dask release evolution

Proposed task: `dask__dask_2022.9.2_2022.10.0` from
[SWE-EVO](https://github.com/SWE-EVO/SWE-EVO). Start with the existing Dask
repository and implement the supplied release requirements while preserving
existing behavior. This is a benchmark selection, not an installed fixture or
a completed experiment.

## Pinned source and ground truth

- Dataset: [Fsoft-AIC/SWE-EVO](https://huggingface.co/datasets/Fsoft-AIC/SWE-EVO),
  revision `77310c70d3648d6815f6a7555ecc492bc28c44ec`.
- [Pinned task records](https://huggingface.co/datasets/Fsoft-AIC/SWE-EVO/blob/77310c70d3648d6815f6a7555ecc492bc28c44ec/SWE-EVO/hf_jsonl/test.jsonl).
- Base commit: `3ef47422b9f830f81562960ef549778819498aa1`.
- Target commit: `feb290395bad802486781a5dc695880df1b907cf`.
- Reference patch: 50 files, including 29 Dask package files (27 Python files);
  other changes include documentation, packaging, and CI configuration.
- Dataset grading lists: 44 `FAIL_TO_PASS` and 2,861 `PASS_TO_PASS` test IDs.
- Environment image supplied by the dataset:
  `xingyaoww/sweb.eval.x86_64.dask_s_dask-9531`.
  Availability and reproducibility remain unverified; resolve and pin its digest
  during preparation rather than treating this tag as immutable.

These counts come from inspecting the pinned dataset record, not running tests.
The benchmark's reference patch and trusted test patch supply the ground truth;
candidate patches need equivalent behavior, not textual equality.

## Why this task

The release adds backend dispatch for array/dataframe IO, an extensible CLI,
groupby median and shuffle improvements, rolling-window support, and runtime
fixes. See the [Dask release notes](https://docs.dask.org/en/stable/changelog.html#v2022-10-0).
Unlike the small algorithm fixtures, it offers substantial work across distinct
modules with shared interfaces and an integration burden.

The hypothesis is that parallel implementation and focused verification improve
completion or elapsed time enough to offset coordination cost. Greater size
alone does not imply a graph advantage. A possible decomposition is interface
planning, parallel backend/array, dataframe, and CLI/runtime work, followed by
integration and regression verification. Shared files need explicit ownership.
The participant should choose its actual graph; do not give only the graph arm
an evaluator-authored solution plan or privileged reference information.

## Proposed comparison

Use raw Codex, single Minion, and graph Minions with the same resolved model,
reasoning effort, starting tree, requirements, tools, and test visibility.
Run three repetitions per arm (nine runs), randomizing arm order within each
repetition. Keep calibration attempts separate and lock the whole cohort before
measured execution. A single task remains a case study, even with repetitions.

Start planning around a 60-minute wall limit per run and at most three concurrent
graph workers. Calibrate and freeze equal aggregate token/cost caps across arms;
the graph cap includes its leader, all workers, retries, and review. Report
cached input, uncached input, output, available cost, and coverage separately.
Do not treat incomplete telemetry as exact usage or allow one arm more budget
after seeing its outcome. Capture planning, work, integration, and verification
timings to explain any advantage or overhead.

Score full resolution, the fraction of the 44 failing tests repaired, retained
regression passes, elapsed time, and total usage. Report budget termination
separately from submission correctness. Thirty failing tests cover groupby;
also show per-subsystem counts, and do not present this suite as exhaustive
verification of every release-note requirement.

## Preparation required before execution

1. Add a task builder and external Python grader through the existing
   [extension contracts](extension-contracts.md), using the upstream test
   semantics and exact expected test IDs. Missing tests must not silently pass.
2. Reproduce the base failures and reference success in a pinned environment;
   reject representative mutants. Resolve dependency or test defects before
   admitting participants, recording any departure from upstream grading.
3. Give participants the same base tests and self-test access. Keep evaluator
   tests, target history, reference patches, and upstream solution links out of
   participant environments. Record any prompt sanitization identically for
   all arms. Use the separate frozen-submission grading path.
4. Verify aggregate child usage and graph integration behavior before the
   measured cohort. Current managed-provider isolation needs work: the existing
   Docker backend implements network `none` only. Local provider runs remain
   exploratory until provider egress and filesystem separation are enforced.

SWE-EVO's [paper](https://arxiv.org/abs/2512.18470) describes the wider benchmark
and its partial-progress metric. This proposed run uses the external `evals/`
controller and its three adapters, not the authors' agent scaffold or an
official leaderboard submission.
