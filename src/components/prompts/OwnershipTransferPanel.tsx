import React from 'react';

export const OwnershipTransferPanel: React.FC<{ promptId?: string }> = ({ promptId }) => {
  return (
    <div className="p-4 bg-slate-800 rounded-lg border border-slate-700 text-white">
      <h3 className="text-lg font-semibold mb-2">Transfer Ownership</h3>
      <p className="text-sm text-slate-400">Transfer management rights for prompt #{promptId || 'unknown'}.</p>
    </div>
  );
};
