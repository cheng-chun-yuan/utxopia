pragma circom 2.1.0;

include "./range_sum_template.circom";

// N=4 instantiation.
component main { public [leafIndices, merkleRoot, ceiling, token, attestation] } = RangeSum(4, 16);
