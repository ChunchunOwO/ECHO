#include "../../audio-engine/ChannelBalanceProcessor.h"
#include "../../audio-engine/EqMessageProtocol.h"
#include "../../audio-engine/EqProcessor.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
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
    requireVectorEquals(buildBufferSizeAttempts(shared), { 512, 1024, 2048, 4096, 8192 }, "shared buffer fallback chain");

    const auto asio = parseOptions({ "echo-audio-host", "-asio" });
    requireVectorEquals(buildBufferSizeAttempts(asio), { 512, 1024, 2048, 4096, 8192 }, "ASIO buffer fallback chain");

    const auto balanced = parseOptions({ "echo-audio-host", "-exclusive", "-buffer", "2048" });
    requireVectorEquals(buildBufferSizeAttempts(balanced), { 2048, 4096, 8192 }, "exclusive requested buffer fallback chain");
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
    PcmRingAudioSource source(2, 512, 1.0f, eqProcessor, channelBalanceProcessor);
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
    PcmRingAudioSource source(2, 512, 1.0f, eqProcessor, channelBalanceProcessor);
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

void testFramedStdinShutdown()
{
    echo::EqProcessor eqProcessor;
    echo::ChannelBalanceProcessor channelBalanceProcessor;
    PcmRingAudioSource source(2, 512, 1.0f, eqProcessor, channelBalanceProcessor);
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
        { "host prebuffer defaults remain compatible", testHostPrebufferDefaultsRemainCompatible },
        { "explicit zero prebuffer disables wait", testExplicitZeroPrebufferDisablesWait },
        { "framed stdin session reset and late PCM drop", testFramedStdinSessionResetAndLatePcmDrop },
        { "framed stdin shutdown", testFramedStdinShutdown },
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
