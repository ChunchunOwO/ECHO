# ECHO Next EQ

ECHO Next EQ is a playable HiFi DSP feature. It is intentionally transparent about the signal path: enabling EQ disables bit-perfect output, even when the selected device path is WASAPI Exclusive or ASIO.

## Phase 1 Scope

- 10-band graphic EQ
- fixed band Q, currently `1.0`
- preamp from `-12 dB` to `+6 dB`
- band gain from `-12 dB` to `+12 dB`
- enable/bypass
- built-in and user presets
- curve visualization
- spectrum analyzer placeholder and native hook point
- clipping/headroom warning

Band frequencies:

```text
31 Hz, 62 Hz, 125 Hz, 250 Hz, 500 Hz, 1 kHz, 2 kHz, 4 kHz, 8 kHz, 16 kHz
```

## Bit-Perfect Rules

EQ enabled:

- `eqEnabled = true`
- `dspActive = true`
- `bitPerfectCandidate = false`
- `bitPerfectDisabledReason = eq_enabled`
- UI shows that output is not bit-perfect

EQ disabled/bypassed:

- native output crossfades back to the dry signal
- EQ must not alter audio once bypass smoothing reaches zero
- `bitPerfectCandidate` may recover if no other DSP, resampling, or output mismatch is active

Flat preset is not the same concept as disabled. Flat has `0 dB` bands and `0 dB` preamp, but if EQ remains enabled the signal path still passes through DSP and is not bit-perfect.

## Native DSP Structure

Native files:

- `native/audio-engine/EqTypes.h`
- `native/audio-engine/EqBand.h`
- `native/audio-engine/EqProcessor.h`
- `native/audio-engine/EqProcessor.cpp`
- `native/audio-engine/EqPresetStore.h`
- `native/audio-engine/EqPresetStore.cpp`
- `native/audio-engine/EqMessageProtocol.h`
- `native/audio-engine/EqMessageProtocol.cpp`

`EqProcessor` is the realtime component. It owns per-channel biquad state, atomic target parameters, preamp smoothing, band gain smoothing, bypass crossfade, and clipping risk detection.

`EqMessageProtocol` parses JSON-line control messages outside the audio callback and updates atomic targets. The PCM stream remains on stdin; realtime EQ commands use a localhost JSON-line control socket so control traffic never mixes with audio bytes.

## Realtime-Safe Rules

The JUCE callback must not:

- allocate large objects
- read or write JSON
- access Electron, React, IPC handlers, or UI state
- wait on a mutex
- perform preset file IO

Parameter updates must:

- clamp invalid values
- use atomic target values
- smooth gain/preamp changes over roughly `25 ms`
- crossfade bypass over roughly `15 ms`
- avoid NaN output during rapid parameter changes

## Electron Bridge

Renderer components use `window.echo.eq` only. The renderer never touches audio buffers.

Commands:

- `eq:get-state`
- `eq:set-enabled`
- `eq:set-band-gain`
- `eq:set-preamp`
- `eq:set-preset`
- `eq:reset`
- `eq:list-presets`
- `eq:save-preset`
- `eq:delete-preset`

Example native control request:

```json
{ "type": "eq:set-band-gain", "band": 3, "gainDb": 2.5 }
```

Example event/state response:

```json
{
  "type": "eq:state",
  "enabled": true,
  "preampDb": -3,
  "bands": [{ "frequencyHz": 31, "gainDb": 0, "q": 1 }]
}
```

## Preset Format

```json
{
  "id": "bass-boost",
  "name": "Bass Boost",
  "preampDb": -2,
  "bands": [
    { "frequencyHz": 31, "gainDb": 4, "q": 1 }
  ],
  "createdAt": "built-in",
  "updatedAt": "built-in",
  "readonly": true
}
```

Built-in presets:

- Flat
- Bass Boost
- Vocal Clear
- Treble Sparkle
- Loudness
- Night
- Headphone Warm
- Anime / J-Pop
- Rock
- Classical

`Flat` is readonly. User presets are stored as JSON under Electron `userData`, validated on load, and rejected if malformed.

## UI Structure

`EqPanel` contains:

- enable/bypass switch
- preset selector
- reset
- A/B placeholder
- EQ curve view
- analyzer placeholder
- preamp slider
- ten vertical band sliders
- bit-perfect/headroom warning
- preset save/delete controls
- import/export placeholders

Slider movement is throttled while dragging, with an accurate final value sent on release.

## Later Scope

- full parametric bands
- realtime analyzer
- dynamic EQ
- auto gain
- A/B compare persistence
- per-output profile
- per-headphone profile

Not in scope:

- VST host
- convolution or room correction
- AutoEQ database
- network preset marketplace
- lyrics/MV/streaming coupling
