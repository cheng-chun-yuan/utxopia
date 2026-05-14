pragma circom 2.1.0;

include "./range_sum_template.circom";

// N=8 instantiation (default range-sum variant).
// Companion variants live in range_sum_4.circom and range_sum_16.circom.
component main { public [leafIndices, merkleRoot, ceiling, token, attestation] } = RangeSum(8, 16);
