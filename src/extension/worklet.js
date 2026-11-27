/**
 * Audio worklet: forwards raw samples to the offscreen document.
 *
 * Plain JS and copied verbatim by the build, because a worklet is loaded by URL
 * into its own realm and cannot be bundled with the rest of the extension.
 *
 * It does no work beyond copying. Anything heavier here stalls the audio
 * thread, which shows up as dropped samples — the one failure that silently
 * costs words.
 */

class MinutoRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];

    // The render quantum's buffer is reused, so it must be copied before it
    // crosses the thread boundary.
    if (channel && channel.length > 0) {
      this.port.postMessage(channel.slice());
    }

    return true;
  }
}

registerProcessor('minuto-recorder', MinutoRecorder);
