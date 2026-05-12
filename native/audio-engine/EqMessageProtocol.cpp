#include "EqMessageProtocol.h"

#include <sstream>

namespace echo
{
namespace
{
std::string boolText(bool value)
{
    return value ? "true" : "false";
}

float getNumber(const juce::DynamicObject& object, const juce::Identifier& key, float fallback)
{
    const auto value = object.getProperty(key);
    return value.isDouble() || value.isInt() ? static_cast<float>(value) : fallback;
}

bool getBool(const juce::DynamicObject& object, const juce::Identifier& key, bool fallback)
{
    const auto value = object.getProperty(key);
    return value.isBool() ? static_cast<bool>(value) : fallback;
}

int getInt(const juce::DynamicObject& object, const juce::Identifier& key, int fallback)
{
    const auto value = object.getProperty(key);
    return value.isInt() || value.isDouble() ? static_cast<int>(value) : fallback;
}

std::string getString(const juce::DynamicObject& object, const juce::Identifier& key)
{
    const auto value = object.getProperty(key);
    return value.isString() ? value.toString().toStdString() : std::string();
}
} // namespace

std::string EqMessageProtocol::createStateMessage(const EqProcessor& processor)
{
    const auto state = processor.getState();
    std::ostringstream output;
    output << "{\"type\":\"eq:state\","
           << "\"enabled\":" << boolText(state.enabled) << ','
           << "\"preampDb\":" << state.preampDb << ','
           << "\"presetName\":\"" << juce::JSON::escapeString(state.presetName).toStdString() << "\","
           << "\"clippingRisk\":" << boolText(processor.hasClippingRisk()) << ','
           << "\"bands\":[";

    for (int index = 0; index < eqBandCount; ++index)
    {
        if (index > 0)
            output << ',';

        output << "{\"frequencyHz\":" << eqFrequenciesHz[static_cast<size_t>(index)]
               << ",\"gainDb\":" << state.bandGainsDb[static_cast<size_t>(index)]
               << ",\"q\":1}";
    }

    output << "]}";
    return output.str();
}

std::string EqMessageProtocol::handleJsonLine(const std::string& line, EqProcessor& processor)
{
    const auto parsed = juce::JSON::parse(juce::String::fromUTF8(line.data(), static_cast<int>(line.size())));
    const auto* object = parsed.getDynamicObject();

    if (object == nullptr)
        return createErrorMessage("unknown", "invalid_json");

    const auto type = getString(*object, "type");

    if (type == "eq:get-state")
        return createStateMessage(processor);

    if (type == "eq:set-enabled")
    {
        processor.setEnabled(getBool(*object, "enabled", false));
        return createStateMessage(processor);
    }

    if (type == "eq:set-band-gain")
    {
        const int band = getInt(*object, "band", -1);

        if (! processor.setBandGainDb(band, getNumber(*object, "gainDb", 0.0f)))
            return createErrorMessage(type, "invalid_band_index");

        return createStateMessage(processor);
    }

    if (type == "eq:set-preamp")
    {
        processor.setPreampDb(getNumber(*object, "preampDb", 0.0f));
        return createStateMessage(processor);
    }

    if (type == "eq:reset")
    {
        processor.resetFlat();
        return createStateMessage(processor);
    }

    if (type == "eq:set-preset")
    {
        processor.setPreampDb(getNumber(*object, "preampDb", 0.0f));
        const auto bands = object->getProperty("bands");
        const auto* bandArray = bands.getArray();

        if (bandArray == nullptr || bandArray->size() != eqBandCount)
            return createErrorMessage(type, "invalid_preset_bands");

        for (int index = 0; index < eqBandCount; ++index)
        {
            const auto* bandObject = bandArray->getReference(index).getDynamicObject();
            if (bandObject == nullptr)
                return createErrorMessage(type, "invalid_preset_band");

            processor.setBandGainDb(index, getNumber(*bandObject, "gainDb", 0.0f));
        }

        return createStateMessage(processor);
    }

    return createErrorMessage(type.empty() ? "unknown" : type, "unsupported_eq_command");
}

std::string EqMessageProtocol::createErrorMessage(const std::string& requestType, const std::string& message)
{
    return std::string("{\"type\":\"eq:error\",\"requestType\":\"")
        + juce::JSON::escapeString(requestType).toStdString()
        + "\",\"message\":\""
        + juce::JSON::escapeString(message).toStdString()
        + "\"}";
}
} // namespace echo
