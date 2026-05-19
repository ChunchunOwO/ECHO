import { app } from 'electron';
import type { WebContents } from 'electron';
import { getCrashReportService } from './CrashReportService';
import { showCrashRecoveryDialog } from './CrashRecoveryDialog';
import { sanitizeLogPayload } from './Logger';
import { recoverClosedHelperPipe, type RuntimeSelfHealSource } from './RuntimeSelfHeal';

const errorMessage = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message;
  }

  return typeof value === 'string' ? value : JSON.stringify(sanitizeLogPayload(value));
};

const errorStack = (value: unknown): string | undefined => (value instanceof Error ? value.stack : undefined);

const safeRead = <T>(reader: () => T, fallback: T): T => {
  try {
    return reader();
  } catch {
    return fallback;
  }
};

const webContentsInfo = (webContents: WebContents): unknown => ({
  id: safeRead(() => webContents.id, -1),
  url: safeRead(() => webContents.getURL(), 'unavailable'),
  title: safeRead(() => webContents.getTitle(), 'unavailable'),
  isDestroyed: safeRead(() => webContents.isDestroyed(), true),
});

export const isClosedPipeWriteError = (error: Error): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EPIPE' || code === 'EOF' || code === 'ERR_STREAM_DESTROYED') {
    return true;
  }

  return /^(?:write\s+)?(?:EOF|EPIPE)$/iu.test(error.message.trim());
};

export const isCleanProcessGoneReason = (reason: string | undefined): boolean => reason === 'clean-exit';

const logHandlerFailure = (phase: string, error: unknown): void => {
  try {
    getCrashReportService().getLogger()?.error('crash', 'crash handler failed', {
      phase,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    console.error('[crash] crash handler failed', phase, error);
  }
};

const logRecoverableMainIssue = (message: string, payload?: unknown): void => {
  try {
    getCrashReportService().getLogger()?.warn('main', message, payload);
  } catch {
    console.warn(message, payload ?? '');
  }
};

const reportCrashSafely = (record: Parameters<ReturnType<typeof getCrashReportService>['reportCrash']>[0]): void => {
  try {
    getCrashReportService().reportCrash(record);
  } catch (error) {
    logHandlerFailure('reportCrash', error);
  }
};

const showCrashRecoveryDialogSafely = (reason: 'main' | 'renderer', message: string): void => {
  try {
    void showCrashRecoveryDialog(reason, message);
  } catch (error) {
    logHandlerFailure('showCrashRecoveryDialog', error);
  }
};

const recoverClosedPipeWriteSafely = (source: RuntimeSelfHealSource, error: Error): void => {
  try {
    void recoverClosedHelperPipe(source, error).catch((recoveryError) => {
      logHandlerFailure('recoverClosedHelperPipe', recoveryError);
    });
  } catch (recoveryError) {
    logHandlerFailure('recoverClosedHelperPipe', recoveryError);
  }
};

export const registerCrashHandlers = (): void => {
  process.on('uncaughtException', (error) => {
    if (isClosedPipeWriteError(error)) {
      logRecoverableMainIssue('ignored closed helper pipe write', {
        message: error.message,
        code: (error as NodeJS.ErrnoException).code ?? null,
      });
      recoverClosedPipeWriteSafely('uncaughtException', error);
      return;
    }

    reportCrashSafely({
      type: 'uncaughtException',
      message: error.message,
      stack: error.stack,
    });
    showCrashRecoveryDialogSafely('main', error.message);
  });

  process.on('unhandledRejection', (reason) => {
    if (reason instanceof Error && isClosedPipeWriteError(reason)) {
      logRecoverableMainIssue('ignored closed helper pipe rejection', {
        message: reason.message,
        code: (reason as NodeJS.ErrnoException).code ?? null,
      });
      recoverClosedPipeWriteSafely('unhandledRejection', reason);
      return;
    }

    reportCrashSafely({
      type: 'unhandledRejection',
      message: errorMessage(reason),
      stack: errorStack(reason),
      reason: errorMessage(reason),
    });
  });

  app.on('render-process-gone', (_event, webContents, details) => {
    if (isCleanProcessGoneReason(details.reason)) {
      logRecoverableMainIssue('ignored clean renderer process exit', {
        details,
      });
      return;
    }

    const message = `Renderer process gone: ${details.reason}`;
    reportCrashSafely({
      type: 'render-process-gone',
      message,
      reason: details.reason,
      exitCode: details.exitCode,
      details: {
        webContents: webContentsInfo(webContents),
        details,
      },
    });
    showCrashRecoveryDialogSafely('renderer', message);
  });

  app.on('child-process-gone', (_event, details) => {
    if (isCleanProcessGoneReason(details.reason)) {
      logRecoverableMainIssue('ignored clean child process exit', {
        details,
      });
      return;
    }

    reportCrashSafely({
      type: 'child-process-gone',
      message: `Child process gone: ${details.type}`,
      reason: details.reason,
      exitCode: details.exitCode,
      details,
    });
  });
};
