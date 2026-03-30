import {
  type TransferTx,
  getTxCommitmentOutputs,
  NullifierInputsList,
  CommitmentRow,
} from "./detail-helpers";

export function StandardTransferDetails({ tx }: { tx: TransferTx }) {
  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        <NullifierInputsList tx={tx} />
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">Outputs</span>
            <span className="text-caption text-purple-400/60 font-medium">{tx.outputs.length}</span>
          </div>
          {getTxCommitmentOutputs(tx).map((out, i) => (
            <CommitmentRow key={out.leafIndex} commitment={out.commitment!} leafIndex={out.leafIndex!} txSignature={tx.txSignature} index={i + 1} />
          ))}
        </div>
      </div>
    </div>
  );
}
