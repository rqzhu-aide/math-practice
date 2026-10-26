# AMC practice bank

**5,435 questions and answer keys from 195 papers**, with 989 question and choice
diagrams. American Mathematics Competitions (AMC) content is credited to the
[Mathematical Association of America (MAA)](https://maa.org/student-programs/amc/)
and distributed with permission under **[CC BY-NC-SA 4.0](LICENSE)**.

| Archive family | Years represented | Papers | Questions |
| --- | --- | ---: | ---: |
| AMC 8 / AJHSME | 1985-2026 | 41 | 1,025 |
| AMC 10 | 2000-2025 | 52 | 1,300 |
| AMC 12 / AHSME | 1950-2025 | 102 | 3,110 |

This is the complete currently processed collection in this project, not a claim
to include every MAA competition. Historical high-school papers have between
25 and 50 questions. The 2021 high-school editions include regular and Fall
papers. Historical series names remain in record metadata.

## Questions and solutions

Choose **AMC contests** in Math Practice, then a level, year, batch, and problem.
Answer checking works without models. Disputed questions retain their historical
choices and key but are not automatically graded; the UI explains the dispute.

Two unchanged **official MAA solution booklets** are included:

- [2023 AMC 8 official solutions](official-solutions/AMC8_2023_Solutions.pdf),
  covering all 25 questions. [MAA source](https://maa.org/resource/sample-competition-2023-amc-8/).
- [2022 AMC 10A official solutions](official-solutions/AMC10A_2022_Solutions.pdf),
  covering all 25 questions. [MAA source](https://maa.org/resource/sample-competition-2022-amc-10-a/).

Matching questions link to their booklet from the solution dialog. The PDF
preserves MAA's mathematics, diagrams, authorship, and copyright notices without
text extraction. These booklets have not been converted into per-question
reference text for the optional model feedback.

The other questions include answer keys and links to their source pages.
**Copied LIVE by Po-Shen Loh worked solutions and 119 solution-only diagrams are
not included.** The `Solution` field is empty throughout this public AMC snapshot;
the 50 questions above additionally carry an `OfficialSolution` PDF reference.
Do not label LIVE explanations as official MAA solutions. Chinese and custom
banks retain their own included worked solutions.

## Provenance and format

Question transcriptions and answer-key provenance come from
[LIVE by Po-Shen Loh's past-contest archive](https://live.poshenloh.com/past-contests).
This source credit is separate from MAA's permission to share the AMC content.
Three retained original question illustrations have their earlier AoPS source
URLs recorded. Per-question metadata preserves source URLs and hashes, reviewed
corrections, figure provenance, and historical series names. Raw website pages,
third-party solution text, private processing files, and local paths are not
included. [sources.json](sources.json) lists historical source URLs and hashes
and the unchanged official solution booklets.

Records use [schema version 2.0](schema.json). The original prompts, choices,
LaTeX, figure positions, and reviewed grading metadata are preserved. Domain
and skill catalogs are in `taxonomy/`; older records with uncurated topics remain
explicitly unclassified. Structural validation does not constitute a proof
audit of every problem or answer key.

To rebuild the bundled browser data after editing published JSON records:

```sh
python scripts/export_amc_bank.py
```

Run that command from the repository root. It needs only Python's standard
library and files already in this repository.

See [NOTICE.md](NOTICE.md) for attribution, modifications, and license scope.
