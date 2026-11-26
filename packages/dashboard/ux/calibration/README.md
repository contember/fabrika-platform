# Reviewer calibration

Pages with defects a person confirmed, for checking a reviewer before its findings are trusted. Never tell the
reviewer which page is which. A fixed canary is spent and replaced, not reused.

| Page                                              | Role                                               | Known defects                                                                                                                                                                 | Confirmed by a person                                                                          |
| ------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `application-secrets` (`/apps/notes/secrets`)     | canary, until secrets and variables are one matrix | one row per name and layer, so a secret set on one environment and missing on another (`PAYMENT_API_KEY`: `prod` only) shows no gap; the `*` layer is named only in the intro | yes: the approved information architecture of the application page names the matrix as the fix |
| `application-approvals` (`/apps/notes/approvals`) | spent: the rules editor was rebuilt                | every category showed all its controls; a changed rule did not stand out; a long paragraph stood above the controls                                                           | yes                                                                                            |
| `/runs`                                           | not clean: replace before the next round           | a waiting run shows a raw "none" and no review action                                                                                                                         | yes: a reviewer reported it and it was confirmed on the page                                   |

A reviewer passes a round when it reports the canary's known defects and nothing on the clean page.
