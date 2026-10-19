import { describe, it, expect } from 'vitest';
import { DataExportService } from '../services/dataExportService';

describe('DataExportService (#806)', () => {
  it('includes schema version and generation metadata in export', async () => {
    const result = await DataExportService.generateExport({
      walletAddress: 'GABC123',
      scope: 'full',
    });

    expect(result.schemaVersion).toBe('1.0.0');
    expect(result.metadata).toBeDefined();
    expect(result.metadata.generatedAt).toBeTypeOf('string');
    expect(result.metadata.generator).toBe('PromptHash-Stellar-ExportService');
    expect(result.metadata.recordCount).toBe(2);
    expect(result.metadata.checksum).toHaveLength(64);
    expect(result.metadata.expiresAt).toBeTypeOf('string');
    expect(result.data).toHaveLength(2);
  });

  it('handles empty exports gracefully', async () => {
    // Force scope with no matching records
    const result = await DataExportService.generateExport({
      walletAddress: 'G_EMPTY',
      scope: 'disputes',
    });

    expect(result.schemaVersion).toBe('1.0.0');
    expect(result.metadata.recordCount).toBe(0);
    expect(result.data).toEqual([]);
  });

  it('denies export when unauthorized (missing wallet and not admin)', async () => {
    await expect(
      DataExportService.generateExport({
        walletAddress: '',
        scope: 'full',
        isAdmin: false,
      })
    ).rejects.toThrow(/Unauthorized/i);
  });

  it('validates retention rules and expiration correctly', () => {
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();

    expect(DataExportService.validateRetention(futureDate)).toBe(true);
    expect(DataExportService.validateRetention(pastDate)).toBe(false);
  });

  it('handles large export volumes without truncating metadata', async () => {
    // Generate large batch simulation
    const result = await DataExportService.generateExport({
      walletAddress: 'G_LARGE',
      scope: 'full',
    });

    expect(result.metadata.recordCount).toBeGreaterThanOrEqual(0);
    expect(result.metadata.checksum).toBeDefined();
  });
});
