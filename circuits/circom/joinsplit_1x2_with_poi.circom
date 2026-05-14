pragma circom 2.1.0;

include "./joinsplit_with_poi.circom";

// Phase 3d-full prototype variant: 1 input, 2 outputs (deposit-claim and
// most-common-transfer shape). assocDepth=20 matches POI_TREE_DEPTH in the
// SDK + proof_of_innocence + attest_poi_hidden circuits.
component main {
    public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut, associationRoot]
} = JoinSplitWithPoI(1, 2, 16, 20);
