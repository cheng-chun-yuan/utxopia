#!/bin/bash
# Shared tier definitions for JoinSplit circuit variants
# Sourced by compile.sh and setup.sh

TIER1_CIRCUITS=("joinsplit_1x1" "joinsplit_1x2" "joinsplit_2x1" "joinsplit_2x2")
TIER2_CIRCUITS=("${TIER1_CIRCUITS[@]}" "joinsplit_1x3" "joinsplit_3x1" "joinsplit_2x3" "joinsplit_3x2" "joinsplit_1x4" "joinsplit_4x1" "joinsplit_1x5" "joinsplit_5x1" "joinsplit_3x3" "joinsplit_2x4" "joinsplit_4x2" "joinsplit_1x6" "joinsplit_6x1" "joinsplit_2x5" "joinsplit_5x2")
