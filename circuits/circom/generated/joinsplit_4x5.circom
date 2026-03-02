pragma circom 2.1.0;

include "../joinsplit.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = JoinSplit(4, 5, 16);
