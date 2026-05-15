#include "../../audio-engine/ChannelBalanceProcessor.h"
#include "../../audio-engine/EqMessageProtocol.h"
#include "../../audio-engine/EqProcessor.h"

#include <juce_audio_basics/juce_audio_basics.h>

#if JUCE_WINDOWS
#include "../third_party/asio-sdk/common/asio.h"
#endif

#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <sstream>
#include <string>
#include <vector>

#define ECHO_AUDIO_HOST_TESTS 1
#include "../src/main.cpp"

namespace
{
constexpr float strictTolerance = 0.0f;
constexpr float nearTolerance = 0.0001f;

void require(bool condition, const std::string& message)
{
    if (! condition)
        throw std::runtime_error(message);
}

void requireContains(const std::string& text, const std::string& needle, const std::string& message)
{
    require(text.find(needle) != std::string::npos, message + " missing: " + needle + " in " + text);
}

void requireVectorEquals(const std::vector<int>& actual, const std::vector<int>& expected, const std::string& message)
{
    require(actual == expected, message);
}

juce::AudioBuffer<float> makeBuffer(int channels, int samples)
{
    juce::AudioBuffer<float> buffer(channels, samples);

    for (int channel = 0; channel < channels; ++channel)
    {
        auto* data = buffer.getWritePointer(channel);
        for (int sample = 0; sample < samples; ++sample)
            data[sample] = 0.15f * std::sin(static_cast<float>(sample + 1) * 0.07f + static_cast<float>(channel) * 0.31f);
    }

    return buffer;
}

void requireBuffersClose(
    const juce::AudioBuffer<float>& actual,
    const juce::AudioBuffer<float>& expected,
    float tolerance,
    const std::string& message)
{
    require(actual.getNumChannels() == expected.getNumChannels(), message + " channel count");
    require(actual.getNumSamples() == expected.getNumSamples(), message + " sample count");

    for (int channel = 0; channel < actual.getNumChannels(); ++channel)
    {
        const auto* actualData = actual.getReadPointer(channel);
        const auto* expectedData = expected.getReadPointer(channel);
        for (int sample = 0; sample < actual.getNumSamples(); ++sample)
        {
            const float delta = std::abs(actualData[sample] - expectedData[sample]);
            require(delta <= tolerance, message + " at channel " + std::to_string(channel) + " sample " + std::to_string(sample));
        }
    }
}

void requireFinite(const juce::AudioBuffer<float>& buffer, const std::string& message)
{
    for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
    {
        const auto* data = buffer.getReadPointer(channel);
        for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
            require(std::isfinite(data[sample]), message);
    }
}

void testDisabledEqIsDry()
{
    echo::EqProcessor processor;
    processor.prepare(48000.0, 512, 2);
    processor.setBandGainDb(2, 12.0f);
    processor.setPreampDb(6.0f);

    auto buffer = makeBuffer(2, 512);
    auto dry = buffer;
    processor.processBlock(buffer, 0, buffer.getNumSamples());

    requireBuffersClose(buffer, dry, strictTolerance, "disabled EQ must be dry");
}

void testFlatEnabledIsTransparent()
{
    echo::EqProcessor processor;
    processor.prepare(44100.0, 1024, 2);
    processor.setEnabled(true);

    auto buffer = makeBuffer(2, 1024);
    auto dry = buffer;
    processor.processBlock(buffer, 0, buffer.getNumSamples());

    require(processor.isEnabled(), "flat enabled EQ must report enabled");
    requireBuffersClose(buffer, dry, nearTolerance, "flat enabled EQ must be transparent");
}

void testBypassReturnsToDry()
{
    echo::EqProcessor processor;
    processor.prepare(48000.0, 4096, 2);
    processor.setEnabled(true);
    processor.setBandGainDb(0, 12.0f);
    processor.setBandGainDb(1, 10.0f);
    processor.setPreampDb(-3.0f);

    auto warmup = makeBuffer(2, 4096);
    processor.processBlock(warmup, 0, warmup.getNumSamples());

    processor.setEnabled(false);
    auto fadeOut = makeBuffer(2, 4096);
    processor.processBlock(fadeOut, 0, fadeOut.getNumSamples());

    auto buffer = makeBuffer(2, 1024);
    auto dry = buffer;
    processor.processBlock(buffer, 0, buffer.getNumSamples());

    require(! processor.isEnabled(), "bypassed EQ must report disabled");
    requireBuffersClose(buffer, dry, strictTolerance, "bypassed EQ must return to dry after fade");
}

void testRapidChangesStayFinite()
{
    for (double sampleRate : { 44100.0, 48000.0, 96000.0 })
    {
        echo::EqProcessor processor;
        processor.prepare(sampleRate, 512, 2);
        processor.setEnabled(true);

        for (int iteration = 0; iteration < 24; ++iteration)
        {
            processor.setPreampDb(iteration % 2 == 0 ? 6.0f : -12.0f);
            processor.setBandGainDb(iteration % echo::eqBandCount, iteration % 2 == 0 ? 12.0f : -12.0f);
            processor.setBandFrequencyHz((iteration + 3) % echo::eqBandCount, iteration % 2 == 0 ? 1.0f : 50000.0f);

            auto buffer = makeBuffer(2, 512);
            processor.processBlock(buffer, 0, buffer.getNumSamples());
            requireFinite(buffer, "rapid EQ changes must stay finite");
        }
    }
}

void testCoefficientUpdatesStopInSteadyState()
{
    echo::EqProcessor processor;
    processor.prepare(96000.0, 512, 2);

    const auto initialUpdates = processor.getCoefficientUpdateCountForTests();
    auto stable = makeBuffer(2, 512);
    processor.processBlock(stable, 0, stable.getNumSamples());
    require(processor.getCoefficientUpdateCountForTests() == initialUpdates, "steady disabled EQ must not recalculate coefficients");

    processor.setEnabled(true);
    auto enabledStable = makeBuffer(2, 512);
    processor.processBlock(enabledStable, 0, enabledStable.getNumSamples());
    require(processor.getCoefficientUpdateCountForTests() == initialUpdates, "steady flat EQ must not recalculate coefficients");

    processor.setBandGainDb(4, 6.0f);
    auto transition = makeBuffer(2, 4096);
    processor.processBlock(transition, 0, transition.getNumSamples());
    const auto afterTransitionUpdates = processor.getCoefficientUpdateCountForTests();
    require(afterTransitionUpdates > initialUpdates, "changed band must recalculate coefficients while smoothing");

    auto postTransition = makeBuffer(2, 4096);
    processor.processBlock(postTransition, 0, postTransition.getNumSamples());
    require(processor.getCoefficientUpdateCountForTests() == afterTransitionUpdates, "steady changed band must stop recalculating coefficients");
}

void testHostBufferFallbackAttempts()
{
    const auto shared = parseOptions({ "echo-audio-host" });
    requireVectorEquals(buildBufferSizeAttempts(shared), { 256, 512, 1024, 2048, 4096, 8192 }, "shared buffer fallback chain");

    const auto asio = parseOptions({ "echo-audio-host", "-asio" });
    requireVectorEquals(buildBufferSizeAttempts(asio), { 256, 512, 1024, 2048, 4096, 8192 }, "ASIO buffer fallback chain");

    const auto balanced = parseOptions({ "echo-audio-host", "-exclusive", "-buffer", "2048" });
    requireVectorEquals(buildBufferSizeAttempts(balanced), { 2048, 4096, 8192 }, "exclusive requested buffer fallback chain");
}

void testHostSharedBackendOptions()
{
    const auto defaultOptions = parseOptions({ "echo-audio-host" });
    require(defaultOptions.sharedBackend == "auto", "shared backend default must be auto");

    const auto directSound = parseOptions({ "echo-audio-host", "-shared-backend", "directsound" });
    require(directSound.sharedBackend == "directsound", "directsound shared backend must parse");
    require(isDisabledSharedBackend(directSound), "directsound backend must be disabled");

    const auto windows = parseOptions({ "echo-audio-host", "-shared-backend", "windows" });
    require(windows.sharedBackend == "windows", "windows shared backend must parse");

    const auto invalid = parseOptions({ "echo-audio-host", "-shared-backend", "invalid" });
    require(invalid.sharedBackend == "auto", "invalid shared backend must fall back to auto");

    require(! shouldIncludeSharedBackendType("DirectSound", directSound.sharedBackend), "disabled directsound backend must skip DirectSound");
    require(! shouldIncludeSharedBackendType("Windows Audio", directSound.sharedBackend), "directsound backend must skip Windows Audio");
    require(shouldIncludeSharedBackendType("Windows Audio", windows.sharedBackend), "windows backend must include Windows Audio");
    require(! shouldIncludeSharedBackendType("DirectSound", windows.sharedBackend), "windows backend must skip DirectSound");
    require(! shouldIncludeSharedBackendType("DirectSound", defaultOptions.sharedBackend), "auto backend must skip DirectSound");
    require(shouldIncludeSharedBackendType("Windows Audio", defaultOptions.sharedBackend), "auto backend must include Windows Audio");
}

void testHostBackendNames()
{
    const auto shared = parseOptions({ "echo-audio-host" });
    require(getBackendName(shared, "Windows Audio") == "wasapi-shared", "Windows Audio shared backend name");
    require(getBackendName(shared, "DirectSound") == "wasapi-shared", "disabled DirectSound must not surface a DirectSound backend name");

    const auto exclusive = parseOptions({ "echo-audio-host", "-exclusive" });
    require(getBackendName(exclusive, "Windows Audio (Exclusive Mode)") == "wasapi-exclusive", "exclusive backend name");

    const auto asio = parseOptions({ "echo-audio-host", "-asio" });
    require(getBackendName(asio, "ASIO") == "asio", "ASIO backend name");
}

void testHostPrebufferDefaultsRemainCompatible()
{
    const auto exclusive = parseOptions({ "echo-audio-host", "-exclusive" });

    require(! exclusive.startupPrebufferMsSpecified, "exclusive prebuffer default must be unspecified");
    require(getStartupPrebufferFrames(exclusive, 48000) == 960, "exclusive default prebuffer must remain compatible");
    require(getStartupPrebufferTimeoutMs(exclusive) == 300, "default prebuffer timeout must remain compatible");
}

void testExplicitZeroPrebufferDisablesWait()
{
    const auto exclusive = parseOptions({
        "echo-audio-host",
        "-exclusive",
        "-prebuffer-ms",
        "0",
        "-prebuffer-timeout-ms",
        "0",
    });

    require(exclusive.startupPrebufferMsSpecified, "zero prebuffer must be tracked as explicit");
    require(exclusive.startupPrebufferTimeoutMsSpecified, "zero prebuffer timeout must be tracked as explicit");
    require(getStartupPrebufferFrames(exclusive, 48000) == 0, "explicit zero prebuffer must disable startup prebuffer");
    require(getStartupPrebufferTimeoutMs(exclusive) == 0, "explicit zero prebuffer timeout must be preserved");

    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    PcmRingAudioSource source(2, 512, 0, 0, 1.0f, eqProcessor, channelBalanceProcessor);
    require(waitForInitialPcm(source, 512, 0) == 0, "zero prebuffer timeout must not wait for PCM");
}

std::vector<char> makePcmPayload(const std::vector<float>& samples)
{
    std::vector<char> payload(samples.size() * sizeof(float));
    std::memcpy(payload.data(), samples.data(), payload.size());
    return payload;
}

StdinFrameHeader makeFrame(StdinFrameType type, uint32_t sessionId, uint32_t payloadBytes = 0)
{
    StdinFrameHeader header;
    header.type = static_cast<uint8_t>(type);
    header.sessionId = sessionId;
    header.payloadBytes = payloadBytes;
    return header;
}

void testFramedStdinSessionResetAndLatePcmDrop()
{
    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    PcmRingAudioSource source(2, 512, 0, 0, 1.0f, eqProcessor, channelBalanceProcessor);
    std::atomic<bool> shutdownRequested { false };
    uint32_t currentSessionId = 0;
    bool hasSession = false;
    std::vector<char> pending;
    const auto payload = makePcmPayload({ 0.1f, 0.2f, 0.3f, 0.4f });

    handleFramedStdinPayload(
        source,
        2,
        shutdownRequested,
        currentSessionId,
        hasSession,
        pending,
        makeFrame(StdinFrameType::BeginSession, 1),
        {});
    handleFramedStdinPayload(
        source,
        2,
        shutdownRequested,
        currentSessionId,
        hasSession,
        pending,
        makeFrame(StdinFrameType::PcmF32Le, 1, static_cast<uint32_t>(payload.size())),
        payload);
    require(source.getReadyFrames() == 2, "current session PCM must enter FIFO");

    handleFramedStdinPayload(
        source,
        2,
        shutdownRequested,
        currentSessionId,
        hasSession,
        pending,
        makeFrame(StdinFrameType::BeginSession, 2),
        {});
    require(source.getReadyFrames() == 0, "begin-session must clear FIFO");
    require(source.getFramesPlayed() == 0, "begin-session must reset position");

    handleFramedStdinPayload(
        source,
        2,
        shutdownRequested,
        currentSessionId,
        hasSession,
        pending,
        makeFrame(StdinFrameType::PcmF32Le, 1, static_cast<uint32_t>(payload.size())),
        payload);
    require(source.getReadyFrames() == 0, "late PCM from old session must be ignored");

    handleFramedStdinPayload(
        source,
        2,
        shutdownRequested,
        currentSessionId,
        hasSession,
        pending,
        makeFrame(StdinFrameType::EndSession, 2),
        {});
    require(source.isDrained(), "end-session must mark empty FIFO drained");
    require(! shutdownRequested.load(), "end-session must not request host shutdown");
}

void testFramedStdinIdleDoesNotCountUnderrunBeforePcm()
{
    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    PcmRingAudioSource source(2, 512, 0, 0, 1.0f, eqProcessor, channelBalanceProcessor);
    auto output = makeBuffer(2, 16);
    juce::AudioSourceChannelInfo info(&output, 0, 16);
    const auto payload = makePcmPayload({ 0.1f, 0.2f, 0.3f, 0.4f });

    source.beginSession();
    source.getNextAudioBlock(info);
    require(source.getUnderrunCallbacks() == 0, "idle session before first PCM must not count underruns");
    require(source.getUnderrunFrames() == 0, "idle session before first PCM must not count underrun frames");

    std::vector<char> pending;
    pushPcmPayload(source, 2, pending, payload);
    source.getNextAudioBlock(info);
    require(source.getUnderrunCallbacks() > 0, "session must count underruns after PCM has started");
}

void testFramedStdinPrebufferDoesNotCountUnderrunBeforeTarget()
{
    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    PcmRingAudioSource source(2, 512, 64, 5000, 1.0f, eqProcessor, channelBalanceProcessor);
    auto output = makeBuffer(2, 16);
    juce::AudioSourceChannelInfo info(&output, 0, 16);
    std::vector<char> pending;

    source.beginSession();
    pushPcmPayload(source, 2, pending, makePcmPayload({ 0.1f, 0.2f, 0.3f, 0.4f }));
    source.getNextAudioBlock(info);
    require(source.getFramesPlayed() == 0, "prebuffering framed session must not consume early PCM");
    require(source.getReadyFrames() == 2, "prebuffering framed session must retain early PCM");
    require(source.getUnderrunCallbacks() == 0, "prebuffering framed session must not count underruns before target");

    std::vector<float> samples(128, 0.15f);
    pushPcmPayload(source, 2, pending, makePcmPayload(samples));
    source.getNextAudioBlock(info);
    require(source.getFramesPlayed() > 0, "framed session must start after the prebuffer target is reached");
}

void testNativeRenderAdapter()
{
    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    PcmRingAudioSource source(2, 64, 0, 0, 1.0f, eqProcessor, channelBalanceProcessor);
    source.prepareForNativeRender(16, 48000.0);
    source.beginSession();

    std::vector<float> emptyOutput(8, 1.0f);
    const auto emptyFrames = source.renderInterleaved(emptyOutput.data(), 4, 2);
    require(emptyFrames == 0, "native render adapter must report zero frames before PCM");
    require(std::all_of(emptyOutput.begin(), emptyOutput.end(), [] (float sample) { return sample == 0.0f; }),
        "native render adapter must clear output before PCM");
    require(source.getUnderrunCallbacks() == 0, "native render adapter must not count underrun before first PCM");

    const std::vector<float> input {
        0.10f, -0.10f,
        0.20f, -0.20f,
        0.30f, -0.30f,
        0.40f, -0.40f,
    };
    require(source.push(input.data(), 4), "native render adapter test PCM push");

    std::vector<float> output(8, 0.0f);
    const auto frames = source.renderInterleaved(output.data(), 4, 2);
    require(frames == 4, "native render adapter must report consumed frame count");

    for (size_t i = 0; i < input.size(); ++i)
        require(std::abs(output[i] - input[i]) <= nearTolerance, "native render adapter must preserve interleaved PCM");
}

#if JUCE_WINDOWS
std::vector<uint32_t> buildAsioCandidates(long minSize, long maxSize, long preferredSize, long granularity, uint32_t requested)
{
    std::vector<uint32_t> values(16, 0);
    const auto count = asio_build_buffer_candidates_for_tests(
        minSize,
        maxSize,
        preferredSize,
        granularity,
        requested,
        values.data(),
        static_cast<uint32_t>(values.size()));
    values.resize(count);
    return values;
}

std::vector<uint32_t> buildAsioRatePivots(double requested)
{
    std::vector<uint32_t> values(8, 0);
    const auto count = asio_build_sample_rate_pivot_candidates_for_tests(
        requested,
        values.data(),
        static_cast<uint32_t>(values.size()));
    values.resize(count);
    return values;
}

void testAsioBufferCandidateGeneration()
{
    auto explicitValid = buildAsioCandidates(128, 4096, 512, 128, 1024);
    require(! explicitValid.empty(), "ASIO explicit valid candidate list");
    require(explicitValid[0] == 1024, "ASIO explicit valid buffer must be first");
    require(std::find(explicitValid.begin(), explicitValid.end(), 512) != explicitValid.end(), "ASIO preferred fallback must be included");

    auto defaultPreferred = buildAsioCandidates(128, 4096, 512, 128, 0);
    require(! defaultPreferred.empty(), "ASIO default candidate list");
    require(defaultPreferred[0] == 512, "ASIO default buffer must prefer driver preferred size");

    auto powerOfTwo = buildAsioCandidates(64, 4096, 512, -1, 300);
    require(std::find(powerOfTwo.begin(), powerOfTwo.end(), 256) != powerOfTwo.end(), "ASIO power-of-two lower candidate");
    require(std::find(powerOfTwo.begin(), powerOfTwo.end(), 512) != powerOfTwo.end(), "ASIO power-of-two preferred candidate");

    auto stepped = buildAsioCandidates(128, 4096, 512, 128, 1000);
    require(std::find(stepped.begin(), stepped.end(), 896) != stepped.end(), "ASIO stepped lower aligned candidate");
    require(std::find(stepped.begin(), stepped.end(), 1024) != stepped.end(), "ASIO stepped upper aligned candidate");
}

void testAsioSampleRatePivotCandidateGeneration()
{
    const auto downTo48 = buildAsioRatePivots(48000.0);
    require(! downTo48.empty(), "ASIO 48k pivot candidates");
    require(downTo48[0] == 44100, "ASIO 48k recovery must pivot away from 48k first");
    require(std::find(downTo48.begin(), downTo48.end(), 48000u) == downTo48.end(), "ASIO 48k pivot must not include requested rate");
    require(std::find(downTo48.begin(), downTo48.end(), 96000u) != downTo48.end(), "ASIO 48k pivot includes high-rate recovery");

    const auto upTo192 = buildAsioRatePivots(192000.0);
    require(! upTo192.empty(), "ASIO 192k pivot candidates");
    require(upTo192[0] == 48000, "ASIO non-48k recovery should try stable 48k first");
    require(std::find(upTo192.begin(), upTo192.end(), 192000u) == upTo192.end(), "ASIO 192k pivot must not include requested rate");
}

void testAsioSampleConversion()
{
    std::vector<unsigned char> bytes(16, 0);
    asio_write_sample_for_tests(bytes.data(), ASIOSTInt16LSB, 0, 1.0f);
    require(reinterpret_cast<int16_t*>(bytes.data())[0] == 32767, "ASIO int16 LSB conversion");

    std::fill(bytes.begin(), bytes.end(), 0);
    asio_write_sample_for_tests(bytes.data(), ASIOSTInt16MSB, 0, 1.0f);
    require(bytes[0] == 0x7f && bytes[1] == 0xff, "ASIO int16 MSB conversion");

    std::fill(bytes.begin(), bytes.end(), 0);
    asio_write_sample_for_tests(bytes.data(), ASIOSTInt24LSB, 0, 1.0f);
    require(bytes[0] == 0xff && bytes[1] == 0xff && bytes[2] == 0x7f, "ASIO int24 LSB conversion");

    std::fill(bytes.begin(), bytes.end(), 0);
    asio_write_sample_for_tests(bytes.data(), ASIOSTInt32LSB24, 0, 1.0f);
    require(reinterpret_cast<int32_t*>(bytes.data())[0] == 0x7fffff00, "ASIO int32 LSB 24-bit aligned conversion");

    std::fill(bytes.begin(), bytes.end(), 0);
    asio_write_sample_for_tests(bytes.data(), ASIOSTFloat32LSB, 0, 0.5f);
    require(std::abs(reinterpret_cast<float*>(bytes.data())[0] - 0.5f) <= nearTolerance, "ASIO float32 LSB conversion");

    std::fill(bytes.begin(), bytes.end(), 0);
    asio_write_sample_for_tests(bytes.data(), ASIOSTFloat64LSB, 0, -0.5f);
    require(std::abs(reinterpret_cast<double*>(bytes.data())[0] + 0.5) <= nearTolerance, "ASIO float64 LSB conversion");

    std::fill(bytes.begin(), bytes.end(), 0);
    asio_write_sample_for_tests(bytes.data(), ASIOSTFloat32MSB, 0, 1.0f);
    require(bytes[0] == 0x3f && bytes[1] == 0x80 && bytes[2] == 0x00 && bytes[3] == 0x00, "ASIO float32 MSB conversion");

    require(std::string(asio_error_name_for_tests(ASE_InvalidMode)) == "ASE_InvalidMode", "ASIO error name helper");
}
#endif

void testFramedStdinShutdown()
{
    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    PcmRingAudioSource source(2, 512, 0, 0, 1.0f, eqProcessor, channelBalanceProcessor);
    std::atomic<bool> shutdownRequested { false };
    uint32_t currentSessionId = 0;
    bool hasSession = false;
    std::vector<char> pending;

    handleFramedStdinPayload(
        source,
        2,
        shutdownRequested,
        currentSessionId,
        hasSession,
        pending,
        makeFrame(StdinFrameType::Shutdown, 0),
        {});
    require(shutdownRequested.load(), "shutdown frame must request host shutdown");
}

void testCleanupEmitsShutdownAckOnce()
{
    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    PcmRingAudioSource source(2, 512, 0, 0, 1.0f, eqProcessor, channelBalanceProcessor);
    juce::AudioSourcePlayer player;
    EqControlServer eqControlServer(0, eqProcessor, channelBalanceProcessor);
    std::unique_ptr<juce::AudioIODevice> device;
    bool shutdownAckSent = false;
    std::ostringstream output;
    auto* oldBuffer = std::cout.rdbuf(output.rdbuf());

    cleanupAudioDeviceAndAck(source, device, player, eqControlServer, shutdownAckSent);
    cleanupAudioDeviceAndAck(source, device, player, eqControlServer, shutdownAckSent);
    std::cout.rdbuf(oldBuffer);

    require(shutdownAckSent, "cleanup must mark shutdown ack sent");
    require(output.str() == "{\"event\":\"shutdown-ack\"}\n", "cleanup must emit shutdown ack exactly once");
}

void testProtocolMessages()
{
    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    eqProcessor.prepare(48000.0, 512, 2);
    channelBalanceProcessor.prepare(48000.0, 512, 2);

    const auto gainResponse = echo::EqMessageProtocol::handleJsonLine(
        R"({"type":"eq:set-band-gain","band":3,"gainDb":4.5})",
        eqProcessor,
        channelBalanceProcessor);
    requireContains(gainResponse, R"("type":"eq:state")", "gain response");
    requireContains(gainResponse, R"("gainDb":4.5)", "gain response");

    const auto frequencyResponse = echo::EqMessageProtocol::handleJsonLine(
        R"({"type":"eq:set-band-frequency","band":3,"frequencyHz":360})",
        eqProcessor,
        channelBalanceProcessor);
    requireContains(frequencyResponse, R"("frequencyHz":360)", "frequency response");

    const std::string presetJson =
        R"({"type":"eq:set-preset","preampDb":-2,"bands":[)"
        R"({"frequencyHz":31,"gainDb":0},{"frequencyHz":62,"gainDb":1},{"frequencyHz":125,"gainDb":2},)"
        R"({"frequencyHz":250,"gainDb":3},{"frequencyHz":500,"gainDb":4},{"frequencyHz":1000,"gainDb":5},)"
        R"({"frequencyHz":2000,"gainDb":4},{"frequencyHz":4000,"gainDb":3},{"frequencyHz":8000,"gainDb":2},)"
        R"({"frequencyHz":16000,"gainDb":1}]})";
    const auto presetResponse = echo::EqMessageProtocol::handleJsonLine(presetJson, eqProcessor, channelBalanceProcessor);
    requireContains(presetResponse, R"("preampDb":-2)", "preset response");
    requireContains(presetResponse, R"("gainDb":5)", "preset response");

    const auto invalidJsonResponse = echo::EqMessageProtocol::handleJsonLine("{not json", eqProcessor, channelBalanceProcessor);
    requireContains(invalidJsonResponse, R"("type":"eq:error")", "invalid json response");
    requireContains(invalidJsonResponse, "invalid_json", "invalid json response");

    const auto invalidBandResponse = echo::EqMessageProtocol::handleJsonLine(
        R"({"type":"eq:set-band-gain","band":99,"gainDb":2})",
        eqProcessor,
        channelBalanceProcessor);
    requireContains(invalidBandResponse, R"("type":"eq:error")", "invalid band response");
    requireContains(invalidBandResponse, "invalid_band_index", "invalid band response");

    const auto invalidPresetResponse = echo::EqMessageProtocol::handleJsonLine(
        R"({"type":"eq:set-preset","preampDb":0,"bands":[{"frequencyHz":31,"gainDb":0}]})",
        eqProcessor,
        channelBalanceProcessor);
    requireContains(invalidPresetResponse, R"("type":"eq:error")", "invalid preset response");
    requireContains(invalidPresetResponse, "invalid_preset_bands", "invalid preset response");
}

} // namespace

int main()
{
    const std::vector<std::pair<std::string, void (*)()>> tests {
        { "disabled EQ is dry", testDisabledEqIsDry },
        { "flat enabled is transparent", testFlatEnabledIsTransparent },
        { "bypass returns to dry", testBypassReturnsToDry },
        { "rapid changes stay finite", testRapidChangesStayFinite },
        { "coefficient updates stop in steady state", testCoefficientUpdatesStopInSteadyState },
        { "host buffer fallback attempts", testHostBufferFallbackAttempts },
        { "host shared backend options", testHostSharedBackendOptions },
        { "host backend names", testHostBackendNames },
        { "host prebuffer defaults remain compatible", testHostPrebufferDefaultsRemainCompatible },
        { "explicit zero prebuffer disables wait", testExplicitZeroPrebufferDisablesWait },
        { "framed stdin session reset and late PCM drop", testFramedStdinSessionResetAndLatePcmDrop },
        { "framed stdin idle does not count underrun before PCM", testFramedStdinIdleDoesNotCountUnderrunBeforePcm },
        { "framed stdin prebuffer does not count underrun before target", testFramedStdinPrebufferDoesNotCountUnderrunBeforeTarget },
        { "native render adapter", testNativeRenderAdapter },
#if JUCE_WINDOWS
        { "ASIO buffer candidate generation", testAsioBufferCandidateGeneration },
        { "ASIO sample-rate pivot candidate generation", testAsioSampleRatePivotCandidateGeneration },
        { "ASIO sample conversion", testAsioSampleConversion },
#endif
        { "framed stdin shutdown", testFramedStdinShutdown },
        { "cleanup emits shutdown ack once", testCleanupEmitsShutdownAckOnce },
        { "protocol messages", testProtocolMessages },
    };

    try
    {
        for (const auto& test : tests)
        {
            test.second();
            std::cout << "[audio-engine-tests] PASS " << test.first << '\n';
        }
    }
    catch (const std::exception& error)
    {
        std::cerr << "[audio-engine-tests] FAIL " << error.what() << '\n';
        return 1;
    }

    return 0;
}
