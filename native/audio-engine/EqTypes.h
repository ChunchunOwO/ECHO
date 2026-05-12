#pragma once

#include <array>
#include <string>
#include <vector>

namespace echo
{
constexpr int eqBandCount = 10;
constexpr float eqMinGainDb = -12.0f;
constexpr float eqMaxGainDb = 12.0f;
constexpr float eqMinPreampDb = -12.0f;
constexpr float eqMaxPreampDb = 6.0f;

using EqGainArray = std::array<float, eqBandCount>;
using EqFrequencyArray = std::array<float, eqBandCount>;

inline constexpr EqFrequencyArray eqFrequenciesHz {
    31.0f,
    62.0f,
    125.0f,
    250.0f,
    500.0f,
    1000.0f,
    2000.0f,
    4000.0f,
    8000.0f,
    16000.0f,
};

struct EqBandState
{
    float frequencyHz = 1000.0f;
    float gainDb = 0.0f;
    float q = 1.0f;
};

struct EqState
{
    bool enabled = false;
    float preampDb = 0.0f;
    EqGainArray bandGainsDb {};
    std::string presetName = "Flat";
};

struct EqPreset
{
    std::string id;
    std::string name;
    float preampDb = 0.0f;
    std::vector<EqBandState> bands;
    std::string createdAt;
    std::string updatedAt;
    bool readonlyPreset = false;
};

inline float clampEqGainDb(float value)
{
    if (value < eqMinGainDb)
        return eqMinGainDb;

    if (value > eqMaxGainDb)
        return eqMaxGainDb;

    return value;
}

inline float clampEqPreampDb(float value)
{
    if (value < eqMinPreampDb)
        return eqMinPreampDb;

    if (value > eqMaxPreampDb)
        return eqMaxPreampDb;

    return value;
}
} // namespace echo
