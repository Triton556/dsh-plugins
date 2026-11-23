// DSH Chrome Bridge - native messaging host.
//
// Chrome spawns this process when the extension connects. It speaks the native
// messaging framing on stdin/stdout (4-byte little-endian length + UTF-8 JSON)
// and exposes the same JSON channel on the named pipe \\.\pipe\dsh-chrome-bridge
// so local tools can drive the browser through the extension.
//
// The host does not parse JSON: requests are forwarded verbatim after an "id"
// is supplied by the client, and replies are matched by that id.

using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

internal static class DshChromeBridgeHost
{
    private const string PipeName = "dsh-browser-bridge";
    private const int MaxFrame = 32 * 1024 * 1024;
    private const int RequestTimeoutSeconds = 120;

    private static readonly object SendLock = new object();
    private static readonly object PairLock = new object();
    private static readonly BlockingCollection<string> Incoming = new BlockingCollection<string>();

    private static Stream _toExtension;
    private static string _logPath;

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(_logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
        }
        catch
        {
            // logging must never break the bridge
        }
    }

    private static string Short(string text, int max)
    {
        if (text == null) return "";
        return text.Length <= max ? text : text.Substring(0, max) + "...";
    }

    private static void Main()
    {
        _logPath = Path.Combine(Path.GetTempPath(), "dsh-browser-bridge.log");
        Log("=== host start pid=" + System.Diagnostics.Process.GetCurrentProcess().Id);

        _toExtension = Console.OpenStandardOutput();
        Stream stdin = Console.OpenStandardInput();

        var reader = new Thread(() => ReadFromExtension(stdin)) { IsBackground = true, Name = "native-in" };
        reader.Start();
        var pipes = new Thread(PipeLoop) { IsBackground = true, Name = "pipe" };
        pipes.Start();

        reader.Join(); // Chrome closes our stdin when the extension disconnects
        Log("stdin closed, host exiting");
    }

    private static void ReadFromExtension(Stream stdin)
    {
        try
        {
            var lengthBytes = new byte[4];
            while (true)
            {
                if (!ReadExact(stdin, lengthBytes, 4)) return;
                int length = BitConverter.ToInt32(lengthBytes, 0);
                if (length <= 0 || length > MaxFrame)
                {
                    Log("bad frame length " + length);
                    return;
                }
                var buffer = new byte[length];
                if (!ReadExact(stdin, buffer, length)) return;
                string message = Encoding.UTF8.GetString(buffer);
                Log("<ext " + Short(message, 200));
                Incoming.Add(message);
            }
        }
        catch (Exception error)
        {
            Log("read error: " + error.Message);
        }
    }

    private static bool ReadExact(Stream stream, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = stream.Read(buffer, offset, count - offset);
            if (read <= 0) return false;
            offset += read;
        }
        return true;
    }

    private static void PipeLoop()
    {
        Log("pipe server listening on \\\\.\\pipe\\" + PipeName);
        while (true)
        {
            try
            {
                using (var server = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte, PipeOptions.None))
                {
                    server.WaitForConnection();
                    try
                    {
                        HandleClient(server);
                    }
                    catch (Exception error)
                    {
                        Log("client error: " + error.Message);
                    }
                }
            }
            catch (Exception error)
            {
                Log("pipe loop error: " + error.Message);
                Thread.Sleep(250);
            }
        }
    }

    private static void HandleClient(Stream pipe)
    {
        var utf8 = new UTF8Encoding(false);
        using (var reader = new StreamReader(pipe, utf8))
        using (var writer = new StreamWriter(pipe, utf8) { AutoFlush = true })
        {
            string line = reader.ReadLine();
            if (string.IsNullOrWhiteSpace(line)) return;
            Log("<- tool " + Short(line, 300));
            string reply = Forward(line);
            Log("-> tool " + Short(reply, 300));
            writer.WriteLine(reply);
        }
    }

    private static string Forward(string requestJson)
    {
        string id = ExtractId(requestJson);
        byte[] payload = Encoding.UTF8.GetBytes(requestJson);
        lock (PairLock)
        {
            try
            {
                lock (SendLock)
                {
                    byte[] length = BitConverter.GetBytes(payload.Length);
                    _toExtension.Write(length, 0, 4);
                    _toExtension.Write(payload, 0, payload.Length);
                    _toExtension.Flush();
                }
            }
            catch (Exception error)
            {
                Log("send to extension failed: " + error.Message);
                return Error(id, "extension channel closed: " + error.Message);
            }

            DateTime deadline = DateTime.UtcNow.AddSeconds(RequestTimeoutSeconds);
            while (true)
            {
                int remaining = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
                if (remaining <= 0) return Error(id, "timeout waiting for the extension");
                string message;
                if (!Incoming.TryTake(out message, Math.Min(remaining, 1000))) continue;
                if (id != null && message.IndexOf("\"id\":\"" + id + "\"", StringComparison.Ordinal) >= 0) return message;
                Log("drop unrelated reply " + Short(message, 120));
            }
        }
    }

    private static string Error(string id, string message)
    {
        string safeId = (id ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        string safeMessage = (message ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
        return "{\"id\":\"" + safeId + "\",\"ok\":false,\"error\":\"" + safeMessage + "\"}";
    }

    private static string ExtractId(string json)
    {
        int start = json.IndexOf("\"id\":\"", StringComparison.Ordinal);
        if (start < 0) return null;
        start += 6;
        int end = json.IndexOf('"', start);
        if (end < 0) return null;
        return json.Substring(start, end - start);
    }
}
