"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
var http_1 = require("http");
var ws_1 = require("ws");
var claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
var sessions = new Map();
var keyCounter = 0;
function generateKey() {
    keyCounter += 1;
    return "session-".concat(Date.now().toString(36), "-").concat(keyCounter);
}
function broadcast(wss, data) {
    var msg = JSON.stringify(data);
    for (var _i = 0, _a = wss.clients; _i < _a.length; _i++) {
        var client = _a[_i];
        if (client.readyState === ws_1.WebSocket.OPEN) {
            client.send(msg);
        }
    }
}
function runSession(wss, sessionKey, prompt, cwd, resumeId) {
    return __awaiter(this, void 0, void 0, function () {
        var abortController, session, iterator, _a, iterator_1, iterator_1_1, message, e_1_1, err_1, errorMessage;
        var _b, e_1, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    abortController = new AbortController();
                    session = {
                        id: sessionKey,
                        sessionId: resumeId !== null && resumeId !== void 0 ? resumeId : null,
                        status: "running",
                        abortController: abortController,
                        queryIterator: null,
                        cwd: cwd,
                    };
                    sessions.set(sessionKey, session);
                    broadcast(wss, {
                        type: "session_status",
                        sessionKey: sessionKey,
                        status: "running",
                    });
                    _e.label = 1;
                case 1:
                    _e.trys.push([1, 14, , 15]);
                    iterator = (0, claude_agent_sdk_1.query)({
                        prompt: prompt,
                        options: {
                            cwd: cwd,
                            resume: resumeId,
                            allowedTools: [
                                "Read", "Write", "Edit", "Bash", "Glob", "Grep",
                                "Agent", "WebFetch", "WebSearch",
                            ],
                            permissionMode: "bypassPermissions",
                            abortController: abortController,
                        },
                    });
                    session.queryIterator = iterator;
                    _e.label = 2;
                case 2:
                    _e.trys.push([2, 7, 8, 13]);
                    _a = true, iterator_1 = __asyncValues(iterator);
                    _e.label = 3;
                case 3: return [4 /*yield*/, iterator_1.next()];
                case 4:
                    if (!(iterator_1_1 = _e.sent(), _b = iterator_1_1.done, !_b)) return [3 /*break*/, 6];
                    _d = iterator_1_1.value;
                    _a = false;
                    message = _d;
                    if (abortController.signal.aborted)
                        return [3 /*break*/, 6];
                    if (message.type === "system" &&
                        "subtype" in message &&
                        message.subtype === "init") {
                        session.sessionId =
                            message["session_id"];
                    }
                    broadcast(wss, {
                        type: "sdk_event",
                        sessionKey: sessionKey,
                        message: message,
                    });
                    if (message.type === "result") {
                        session.status = "idle";
                        broadcast(wss, {
                            type: "session_status",
                            sessionKey: sessionKey,
                            status: "idle",
                            sessionId: session.sessionId,
                        });
                    }
                    _e.label = 5;
                case 5:
                    _a = true;
                    return [3 /*break*/, 3];
                case 6: return [3 /*break*/, 13];
                case 7:
                    e_1_1 = _e.sent();
                    e_1 = { error: e_1_1 };
                    return [3 /*break*/, 13];
                case 8:
                    _e.trys.push([8, , 11, 12]);
                    if (!(!_a && !_b && (_c = iterator_1.return))) return [3 /*break*/, 10];
                    return [4 /*yield*/, _c.call(iterator_1)];
                case 9:
                    _e.sent();
                    _e.label = 10;
                case 10: return [3 /*break*/, 12];
                case 11:
                    if (e_1) throw e_1.error;
                    return [7 /*endfinally*/];
                case 12: return [7 /*endfinally*/];
                case 13: return [3 /*break*/, 15];
                case 14:
                    err_1 = _e.sent();
                    errorMessage = err_1 instanceof Error ? err_1.message : String(err_1);
                    session.status = "error";
                    broadcast(wss, {
                        type: "session_error",
                        sessionKey: sessionKey,
                        error: errorMessage,
                    });
                    return [3 /*break*/, 15];
                case 15: return [2 /*return*/];
            }
        });
    });
}
function handleCommand(wss, cmd, ws) {
    var _a, _b, _c;
    switch (cmd.type) {
        case "create_session": {
            var key = generateKey();
            var cwd = (_a = cmd.cwd) !== null && _a !== void 0 ? _a : process.cwd();
            var prompt_1 = (_b = cmd.prompt) !== null && _b !== void 0 ? _b : "Hello";
            runSession(wss, key, prompt_1, cwd);
            ws.send(JSON.stringify({
                type: "session_created",
                sessionKey: key,
            }));
            break;
        }
        case "send_message": {
            if (!cmd.sessionKey || !cmd.prompt) {
                ws.send(JSON.stringify({
                    type: "error",
                    message: "sessionKey and prompt required",
                }));
                return;
            }
            var session = sessions.get(cmd.sessionKey);
            if (!session) {
                ws.send(JSON.stringify({
                    type: "error",
                    message: "Session ".concat(cmd.sessionKey, " not found"),
                }));
                return;
            }
            runSession(wss, cmd.sessionKey, cmd.prompt, session.cwd, (_c = session.sessionId) !== null && _c !== void 0 ? _c : undefined);
            break;
        }
        case "stop_session": {
            if (!cmd.sessionKey)
                return;
            var session = sessions.get(cmd.sessionKey);
            if (session) {
                session.abortController.abort();
                session.status = "stopped";
                broadcast(wss, {
                    type: "session_status",
                    sessionKey: cmd.sessionKey,
                    status: "stopped",
                });
            }
            break;
        }
    }
}
var PORT = parseInt((_a = process.env["PORT"]) !== null && _a !== void 0 ? _a : "3141", 10);
var server = (0, http_1.createServer)();
var wss = new ws_1.WebSocketServer({ server: server });
wss.on("connection", function (ws) {
    console.log("Client connected");
    var sessionList = Array.from(sessions.entries()).map(function (_a) {
        var key = _a[0], s = _a[1];
        return ({
            sessionKey: key,
            sessionId: s.sessionId,
            status: s.status,
            cwd: s.cwd,
        });
    });
    ws.send(JSON.stringify({
        type: "session_list",
        sessions: sessionList,
    }));
    ws.on("message", function (raw) {
        try {
            var cmd = JSON.parse(String(raw));
            handleCommand(wss, cmd, ws);
        }
        catch (err) {
            var msg = err instanceof Error ? err.message : String(err);
            ws.send(JSON.stringify({ type: "error", message: msg }));
        }
    });
    ws.on("close", function () {
        console.log("Client disconnected");
    });
});
server.listen(PORT, function () {
    console.log("Claude Canvas server on ws://localhost:".concat(PORT));
});
