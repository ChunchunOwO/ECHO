import type { CoverCacheRepairOptions, CoverExtractOptions, CoverResult, MetadataResult } from '../libraryTypes';

export type LibraryScanWorkerRequest =
  | {
      requestId: number;
      type: 'metadata:read';
      filePath: string;
    }
  | {
      requestId: number;
      type: 'cover:extract';
      filePath: string;
      options: CoverExtractOptions;
    }
  | {
      requestId: number;
      type: 'cover:repair';
      options: CoverCacheRepairOptions;
    };

export type LibraryScanWorkerResult = MetadataResult | CoverResult;

export type LibraryScanWorkerResponse =
  | {
      requestId: number;
      ok: true;
      result: LibraryScanWorkerResult;
    }
  | {
      requestId: number;
      ok: false;
      message: string;
    };

export type LibraryScanWorkerRequestForType<Type extends LibraryScanWorkerRequest['type']> = Extract<
  LibraryScanWorkerRequest,
  { type: Type }
>;

export type LibraryScanWorkerResultForType<Type extends LibraryScanWorkerRequest['type']> =
  Type extends 'metadata:read' ? MetadataResult : CoverResult;
