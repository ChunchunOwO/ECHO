#include "EqPresetStore.h"

#include <cmath>

namespace echo
{
namespace
{
EqPreset makePreset(const std::string& id, const std::string& name, float preampDb, const EqGainArray& gains)
{
    EqPreset preset;
    preset.id = id;
    preset.name = name;
    preset.preampDb = clampEqPreampDb(preampDb);
    preset.readonlyPreset = true;
    preset.createdAt = "built-in";
    preset.updatedAt = "built-in";
    preset.bands.reserve(eqBandCount);

    for (int index = 0; index < eqBandCount; ++index)
    {
        preset.bands.push_back({
            eqFrequenciesHz[static_cast<size_t>(index)],
            clampEqGainDb(gains[static_cast<size_t>(index)]),
            1.0f,
        });
    }

    return preset;
}
} // namespace

std::vector<EqPreset> EqPresetStore::createBuiltInPresets()
{
    return {
        makePreset("flat", "Flat", 0.0f, {}),
        makePreset("bass-boost", "Bass Boost", -2.0f, { 4.0f, 3.5f, 2.5f, 1.0f, 0.0f, 0.0f, 0.0f, -0.5f, -1.0f, -1.0f }),
        makePreset("vocal-clear", "Vocal Clear", -1.5f, { -2.0f, -1.5f, -1.0f, 0.5f, 1.5f, 2.5f, 2.0f, 1.0f, 0.0f, -0.5f }),
        makePreset("treble-sparkle", "Treble Sparkle", -2.0f, { -1.0f, -0.8f, -0.5f, 0.0f, 0.0f, 0.5f, 1.2f, 2.4f, 3.4f, 3.0f }),
        makePreset("loudness", "Loudness", -4.0f, { 4.0f, 3.5f, 2.0f, 0.5f, -0.5f, -0.5f, 0.3f, 1.5f, 2.2f, 2.4f }),
        makePreset("night", "Night", -4.0f, { -2.0f, -2.0f, -1.5f, -0.5f, 0.0f, 1.0f, 0.8f, -0.5f, -2.0f, -3.0f }),
        makePreset("headphone-warm", "Headphone Warm", -2.0f, { 1.5f, 2.0f, 2.0f, 1.2f, 0.4f, 0.0f, -0.4f, -0.8f, -1.0f, -1.2f }),
        makePreset("anime-jpop", "Anime / J-Pop", -3.0f, { 1.5f, 1.2f, 0.6f, -0.5f, -0.8f, 0.8f, 2.0f, 2.6f, 2.2f, 1.0f }),
        makePreset("rock", "Rock", -3.0f, { 2.5f, 2.0f, 1.0f, -0.5f, -1.0f, 0.0f, 1.2f, 2.3f, 2.0f, 1.2f }),
        makePreset("classical", "Classical", -1.0f, { 0.5f, 0.5f, 0.0f, 0.0f, -0.3f, -0.2f, 0.4f, 1.0f, 1.2f, 0.8f }),
    };
}

bool EqPresetStore::validatePreset(const EqPreset& preset)
{
    if (preset.id.empty() || preset.name.empty() || preset.bands.size() != static_cast<size_t>(eqBandCount))
        return false;

    if (! std::isfinite(preset.preampDb) || preset.preampDb < eqMinPreampDb || preset.preampDb > eqMaxPreampDb)
        return false;

    for (int index = 0; index < eqBandCount; ++index)
    {
        const auto& band = preset.bands[static_cast<size_t>(index)];

        if (! std::isfinite(band.frequencyHz) || std::abs(band.frequencyHz - eqFrequenciesHz[static_cast<size_t>(index)]) > 0.5f)
            return false;

        if (! std::isfinite(band.gainDb) || band.gainDb < eqMinGainDb || band.gainDb > eqMaxGainDb)
            return false;

        if (! std::isfinite(band.q) || band.q <= 0.0f || band.q > 12.0f)
            return false;
    }

    return true;
}
} // namespace echo
