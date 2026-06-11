using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

const string PluginPackageType = "echo-next-plugin-package";
const int PluginPackageVersion = 1;
const string FeatureId = "connect";
const string PluginId = "echo.connect-donator-unlock";
const string LicenseFileName = "donator.machine-license.json";
const int LicenseVersion = 1;
const string LicenseAlgorithm = "aes-256-gcm";
const string LicenseKeyBase64 = "H1qOend5BTwz+pFWb6M7WGIDphqgnCNne8R9dB9CJLU=";

var utf8NoBom = new UTF8Encoding(false);

try
{
    Console.Title = "ECHO Connect Donator Unlock";
    Console.WriteLine("ECHO Connect Donator Unlock Issuer");
    Console.WriteLine("----------------------------------");

    var hwidHash = GetHwidHash();
    var packageJson = CreatePluginPackageJson(hwidHash);
    var outputDirectory = AppContext.BaseDirectory;
    var outputPath = GetAvailableOutputPath(outputDirectory, hwidHash);
    File.WriteAllText(outputPath, packageJson + Environment.NewLine, utf8NoBom);

    Console.WriteLine($"HWID SHA-256 : {hwidHash}");
    Console.WriteLine($"Plugin       : {outputPath}");
    Console.WriteLine();
    Console.WriteLine("Import this .echo file in ECHO NEXT Plugins, then enable it.");
    ScheduleSelfDelete();
}
catch (Exception error)
{
    Console.Error.WriteLine("Failed to create donator unlock plugin.");
    Console.Error.WriteLine(error.Message);
    Environment.ExitCode = 1;
}
finally
{
    if (Environment.ExitCode != 0 && Environment.UserInteractive && !Console.IsInputRedirected)
    {
        Console.WriteLine();
        Console.Write("Press Enter to exit...");
        Console.ReadLine();
    }
}

static string CreatePluginPackageJson(string hwidHash)
{
    var exportedAt = DateTimeOffset.UtcNow.ToString("O");
    var licenseJson = CreateEncryptedLicenseJson(hwidHash);
    return $$"""
{
  "type": "{{JsonEscape(PluginPackageType)}}",
  "version": {{PluginPackageVersion}},
  "exportedAt": "{{JsonEscape(exportedAt)}}",
  "manifest": {
    "id": "{{JsonEscape(PluginId)}}",
    "name": "Connect Donator Unlock",
    "version": "1.0.0",
    "apiVersion": 2,
    "entry": "plugin.js",
    "permissions": [],
    "contributes": {
      "commands": [],
      "panels": [],
      "trackContextMenus": [],
      "metadataProviders": [],
      "sourceProviders": [],
      "lyricsProviders": [],
      "coverProviders": [],
      "themePresets": [],
      "settings": []
    }
  },
  "files": [
    {
      "path": "plugin.js",
      "content": "// Connect Donator unlock marker plugin. Keep this plugin installed and enabled.\n"
    },
    {
      "path": "{{JsonEscape(LicenseFileName)}}",
      "content": "{{JsonEscape(licenseJson + "\n")}}"
    }
  ]
}
""";
}

static string CreateEncryptedLicenseJson(string hwidHash)
{
    var issuedAt = DateTimeOffset.UtcNow.ToString("O");
    var payload = $$"""{"version":{{LicenseVersion}},"featureId":"{{JsonEscape(FeatureId)}}","pluginId":"{{JsonEscape(PluginId)}}","issuedAt":"{{JsonEscape(issuedAt)}}","hwidHash":"{{JsonEscape(hwidHash)}}"}""";

    var key = Convert.FromBase64String(LicenseKeyBase64);
    var iv = RandomNumberGenerator.GetBytes(12);
    var plaintext = Encoding.UTF8.GetBytes(payload);
    var ciphertext = new byte[plaintext.Length];
    var tag = new byte[16];
    using var aes = new AesGcm(key, tag.Length);
    aes.Encrypt(iv, plaintext, ciphertext, tag);

    return $$"""
{
  "version": {{LicenseVersion}},
  "algorithm": "{{JsonEscape(LicenseAlgorithm)}}",
  "issuedAt": "{{JsonEscape(issuedAt)}}",
  "iv": "{{JsonEscape(Convert.ToBase64String(iv))}}",
  "tag": "{{JsonEscape(Convert.ToBase64String(tag))}}",
  "ciphertext": "{{JsonEscape(Convert.ToBase64String(ciphertext))}}"
}
""";
}

static string GetAvailableOutputPath(string outputDirectory, string hwidHash)
{
    var prefix = hwidHash[..8];
    var basePath = Path.Combine(outputDirectory, $"{PluginId}-{prefix}.echo");
    if (!File.Exists(basePath))
    {
        return basePath;
    }

    var timestamp = DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss");
    return Path.Combine(outputDirectory, $"{PluginId}-{prefix}-{timestamp}.echo");
}

static string GetHwidHash()
{
    var machineGuid = GetWindowsMachineGuid();
    if (string.IsNullOrWhiteSpace(machineGuid))
    {
        throw new InvalidOperationException("Windows MachineGuid is unavailable.");
    }
    return Sha256Hex($"echo-connect-donator:win:{machineGuid.Trim()}");
}

static string? GetWindowsMachineGuid()
{
    if (!OperatingSystem.IsWindows())
    {
        return null;
    }

    using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
    return key?.GetValue("MachineGuid") as string;
}

static string Sha256Hex(string value)
{
    var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
    return Convert.ToHexString(bytes).ToLowerInvariant();
}

static string JsonEscape(string value)
{
    var builder = new StringBuilder(value.Length + 8);
    foreach (var character in value)
    {
        builder.Append(character switch
        {
            '"' => "\\\"",
            '\\' => "\\\\",
            '\b' => "\\b",
            '\f' => "\\f",
            '\n' => "\\n",
            '\r' => "\\r",
            '\t' => "\\t",
            < ' ' => $"\\u{(int)character:x4}",
            _ => character,
        });
    }
    return builder.ToString();
}

static void ScheduleSelfDelete()
{
    var executablePath = Environment.ProcessPath;
    if (string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath))
    {
        return;
    }

    var command = $"/c timeout /t 2 /nobreak > nul & del /f /q \"{executablePath}\"";
    Process.Start(new ProcessStartInfo
    {
        FileName = "cmd.exe",
        Arguments = command,
        CreateNoWindow = true,
        UseShellExecute = false,
        WindowStyle = ProcessWindowStyle.Hidden,
    });
}
