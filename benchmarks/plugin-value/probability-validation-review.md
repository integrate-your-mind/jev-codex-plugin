# Probability validation review

## Scope

This is a separate current-turn observation and is **not** one of the four
invalid responses in the paired pilot. The inspected receipt was
`755db7a9-74fd-4fb7-9976-bfd02f8658d1`; only its bounded transport and
validation metadata were used.

Observed metadata:

- HTTP response status: `200`
- Jev status: `unavailable`
- reason: `invalid_response`
- `validatedResponse`: `false`
- `responseValidationFailure`: `probability_sum_invalid`
- diagnostic question: `decision`
- probability sum: `0.9900000000000001`
- deviation from 1: `0.009999999999999898`

## Contract comparison

The current local validator in `source/jev-workflows/src/provider.ts` sums the
Choice/Score probability values and accepts only when `Math.abs(sum - 1) <=
0.001`. The observed deviation is approximately `0.01`, so this receipt is
correctly rejected by the installed local contract. It is not a floating-point
rounding-sized discrepancy.

The official TypeSafe API reference says that Choice returns the full
probability distribution and that the probabilities are floats that “sum to
1”; the Score response describes its level probabilities with the same
requirement. The reference does not specify a normalization rule or a numeric
tolerance. See [TypeSafe API reference](https://docs.typesafe.ai/api), Choice
answer fields, and Score answer fields. The confidence page likewise describes
the distribution as the basis for confidence, without defining a tolerance or
normalization step: [TypeSafe confidence](https://docs.typesafe.ai/confidence).

## Recommendation

Keep the current rejection behavior. A one-percent deficit is materially
different from serialization noise, and the public contract requires a
distribution summing to one. Do not silently normalize the response or relax
the threshold without an official TypeSafe contract change or a bounded set of
provider responses showing that such deficits are systematic and intended.

The evidence supports this narrow conclusion only: the HTTP transport
succeeded, but the response did not satisfy Jev's local structural contract.
It does not establish provider billing, model quality, or the failure causes of
the four paired-pilot invalid responses.
