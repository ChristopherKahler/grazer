// grazer.exe — a thin native shim so `spawn("grazer", args)` works on Windows.
//
// Node's spawn() without a shell only resolves .exe on PATH, so a .cmd or a
// bare .mjs is invisible to it. The harness's own e2e runner spawns `grazer`
// that way, so Grazer needs a real executable. This forwards to
// `node bin/grazer.mjs`, inherits stdio so heredocs and pipes pass straight
// through, and exits with the child's exit code — the CLI's exit codes are a
// contract (0 ok, 1 script threw, 2 usage, 3 environment) and must survive.
//
// argv is forwarded as the RAW tail of this process's command line rather than
// a re-joined string[]. Re-quoting argv damages arguments that already carry
// quotes or backslashes, and agents pipe JavaScript through here.

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;

internal static class GrazerLauncher
{
    // What cmd.exe returns when a command cannot be found.
    private const int CommandNotFound = 9009;

    /// Everything after argv[0]. Windows parses the program name specially:
    /// quoted, or up to the first whitespace, with no escape processing.
    internal static string ArgumentTail(string commandLine)
    {
        int i = 0;
        if (i < commandLine.Length && commandLine[i] == '"')
        {
            i++;
            while (i < commandLine.Length && commandLine[i] != '"') i++;
            if (i < commandLine.Length) i++;
        }
        else
        {
            while (i < commandLine.Length && !char.IsWhiteSpace(commandLine[i])) i++;
        }
        return commandLine.Substring(i).TrimStart();
    }

    private static int Main()
    {
        string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string script = Path.GetFullPath(Path.Combine(exeDir, "grazer.mjs"));
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("grazer: cannot find grazer.mjs next to " + exeDir);
            return CommandNotFound;
        }

        string tail = ArgumentTail(Environment.CommandLine);
        string arguments = "\"" + script + "\"" + (tail.Length > 0 ? " " + tail : "");

        var info = new ProcessStartInfo("node.exe", arguments);
        info.UseShellExecute = false; // inherit our stdin, stdout and stderr

        try
        {
            using (Process child = Process.Start(info))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Win32Exception error)
        {
            Console.Error.WriteLine("grazer: could not run node (" + error.Message + ")");
            return CommandNotFound;
        }
    }
}
