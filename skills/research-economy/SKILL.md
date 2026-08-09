---
name: research-economy
description: Use when web research, large articles, PDFs, broad source discovery, multi-model investigation, or other context-expensive retrieval is required.
---

# Research Economy

## Overview

Protect the main session by importing evidence, not raw source material. Delegate public-source breadth; keep synthesis and sensitive work in the trusted main session.

## Research Contract

Before retrieval, state:

1. One research question.
2. The expected decision or output.
3. A stopping condition.
4. A main-context budget, defaulting to at most 5,000 additional tokens.
5. Whether any input is private, proprietary, personal, regulated, or credential-adjacent.

## Routing

| Work | Route |
|---|---|
| Public overview and source discovery | `research-economy` subagent |
| Full reading of a large public source | `research-economy` subagent |
| Project-specific synthesis and decisions | Main model |
| Private repositories or internal documents | Trusted main model only |
| Decision-critical factual verification | Main model using a precise excerpt |

Never send private material, private paths, internal summaries, secrets, personal data, or proprietary terminology to the economy agent. Convert mixed research into a generic public brief before delegation.

## Retrieval Limits

- Do not fetch multiple unknown-size sources directly into the main context.
- First request metadata, an abstract, headings, search hits, or one exact excerpt.
- Ask each delegate for at most 600 tokens, including URLs, exact page/section locators, uncertainty, and contradictions.
- For several sources, require one combined response within the same 600-token limit unless separate reports are decision-critical.
- Fetch a full source in the main session only when compact retrieval cannot verify a decision-critical claim.
- Use a second delegate only for independent coverage or criticism, never duplicate summaries.

## Stop Rules

Stop when the decision-relevant claims have precise support, additional sources repeat existing evidence, the 5,000-token budget is reached, or two retrieval attempts fail. Return a qualified partial result instead of expanding research indefinitely.

## Red Flags

- Loading a long article or PDF before checking its size
- Returning general summaries without locators
- Importing multiple 1,000+ token subagent reports
- Sending internal material to the cheap model because it is convenient
- Continuing research without a stated stopping condition

If any red flag applies, pause and narrow the request before retrieving more data.

## Common Mistakes

| Mistake | Correction |
|---|---|
| Treating cheap as private | Cheap models receive public, non-sensitive briefs only |
| Asking for full summaries | Ask for decision-relevant claims and precise excerpts |
| Delegating final judgment | Keep synthesis in the main model |
| Measuring activity instead of value | Stop when further sources will not change the decision |
