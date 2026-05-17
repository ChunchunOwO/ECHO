let audioCommandQueue: Promise<void> = Promise.resolve();

export const enqueueAudioCommand = <T>(fn: () => Promise<T> | T): Promise<T> => {
  const result = audioCommandQueue.then(() => fn());
  audioCommandQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};
