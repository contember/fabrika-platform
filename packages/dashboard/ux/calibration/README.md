# Reviewer calibration

Pages with defects a person confirmed, for checking a reviewer before its findings are trusted. Never tell the
reviewer which page is which. A fixed canary is spent and replaced, not reused.

| Page                                              | Role                                                        | Known defects                                                                                                                             | Confirmed by a person                                                 |
| ------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `application-access` (`/apps/notes/access/prod`)  | spent: the tab became one environment at a time             | every section listed both environments at once, with no environment switcher; a paragraph of two or three lines stood before each section | yes                                                                   |
| `application-secrets` (`/apps/notes/secrets`)     | spent: secrets and variables became one matrix              | a secret set on one environment only showed no gap                                                                                        | yes                                                                   |
| `application-approvals` (`/apps/notes/approvals`) | not clean: replace before the next round; spent as a canary | its intro names the permission code `access.approve`                                                                                      | yes: a reviewer reported it and the text was read in the code         |
| `/runs`                                           | not clean: replace before the next round                    | a waiting run shows a raw "none" and no review action                                                                                     | yes: a reviewer reported it and it was confirmed on the page          |
| `application-settings` (`/apps/notes/settings`)   | canary, until the confirmation is rewritten                 | deleting an environment confirms with its name only, without what goes and what stays                                                     | yes: a reviewer reported it and the confirmation was read in the code |

A reviewer passes a round when it reports the canary's known defects and nothing on the clean page. No clean page is known now: the next round needs a candidate.
