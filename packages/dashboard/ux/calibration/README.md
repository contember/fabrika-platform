# Reviewer calibration

Pages with defects a person confirmed, for checking a reviewer before its findings are trusted. Never tell the
reviewer which page is which. A fixed canary is spent and replaced, not reused.

| Page                                              | Role                                          | Known defects                                                                                                                                                                                                               | Confirmed by a person                                                                                |
| ------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `application-approvals` (`/apps/notes/approvals`) | canary, until the approvals editor is rebuilt | every change category shows all its controls whether it differs from the default or not (about 80 controls); a changed rule does not stand out from a default one; a paragraph of about 100 words stands above the controls | yes: the approved information architecture of the application page names these as the problem to fix |
| `/runs`                                           | clean page candidate                          | none known                                                                                                                                                                                                                  | not yet                                                                                              |

A reviewer passes a round when it reports the canary's known defects and nothing on the clean page.
