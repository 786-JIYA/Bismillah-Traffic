const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const generateTrafficData = require("./simulation");
const calculateGreenTime  = require("./signalLogic");

// =========================
// EXPRESS APP
// =========================

const app = express();

app.use(cors());
app.use(express.json());

// Serve public folder (frontend)
app.use(express.static(path.join(__dirname, "public")));

// Serve violations folder — FULL path so images load from frontend
app.use("/violations", express.static(path.join(__dirname, "public/violations")));

// =========================
// HTTP + SOCKET SERVER
// =========================

const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" },
});

// =========================
// CONSTANTS
// =========================

const laneOrder = ["north", "south", "east", "west"];
const BASE_TIME = 15;
const K         = 0.8;

// =========================
// GLOBAL STATE
// =========================

let currentLaneIndex = 0;
let simulationMode   = true;
let lastAIUpdate     = Date.now();
let cycleTimeout     = null;
let manualTrigger    = false;

let currentState = {
    activeLane: "north",
    greenTime:  30,
    timer:      30,
    signalRed:  false,
    counts:  { north: 0, south: 0, east: 0, west: 0 },
    timings: { north: 15, south: 15, east: 15, west: 15 },
    signals: { north: "green", south: "red", east: "red", west: "red" },
    emergency:  { active: false, lane: null },
    violations: [],
};

// =========================
// HELPERS
// =========================

function emitTrafficUpdate() {
    io.emit("traffic-update", currentState);
}

function computeGreenTime(count) {
    return Math.min(90, Math.max(10, BASE_TIME + Math.round(K * count)));
}

// =========================
// ROUTES
// =========================

app.get("/", (req, res) => {
    res.send("Bismillah — AI Junction Optimization Backend Running");
});

// ── Update counts (Python posts here) ──
app.post("/api/update-counts", (req, res) => {
    const counts = req.body;
    lastAIUpdate = Date.now();
    currentState.counts = counts;

    currentState.timings = {
        north: computeGreenTime(counts.north || 0),
        south: computeGreenTime(counts.south || 0),
        east:  computeGreenTime(counts.east  || 0),
        west:  computeGreenTime(counts.west  || 0),
    };

    io.emit("trafficUpdate", {
        A: counts.north || 0,
        B: counts.south || 0,
        C: counts.east  || 0,
        D: counts.west  || 0,
    });

    emitTrafficUpdate();
    res.json({ success: true, timings: currentState.timings });
});

// ── Get current state (Python reads signal here) ──
app.get("/api/state", (req, res) => {
    res.json({
        activeLane: currentState.activeLane,
        greenTime:  currentState.greenTime,
        timer:      currentState.timer,
        signalRed:  currentState.signalRed,
        counts:     currentState.counts,
        timings:    currentState.timings,
        signals:    currentState.signals,
        emergency:  currentState.emergency,
    });
});

// ── Get violations list ──
app.get("/api/violations", (req, res) => {
    res.json(currentState.violations);
});

// ── Toggle simulation mode ──
app.post("/api/toggle-mode", (req, res) => {
    simulationMode = !simulationMode;
    console.log(`Simulation Mode: ${simulationMode}`);
    res.json({ success: true, simulationMode });
});

// ── Emergency override ──
app.post("/api/emergency", (req, res) => {
    const { lane } = req.body;

    currentState.emergency = { active: true, lane };
    currentState.activeLane = lane;

    for (const l of laneOrder) currentState.signals[l] = "red";
    currentState.signals[lane] = "green";
    currentState.greenTime = 120;
    currentState.timer     = 120;

    emitTrafficUpdate();
    io.emit("emergency", { lane });

    console.log(`🚑 Emergency Activated: ${lane}`);
    res.json({ success: true, message: `Emergency enabled for ${lane}` });
});

// ── Clear emergency ──
app.post("/api/clear-emergency", (req, res) => {
    currentState.emergency = { active: false, lane: null };
    console.log("✅ Emergency Cleared");
    emitTrafficUpdate();
    startTrafficCycle();
    res.json({ success: true, message: "Emergency cleared" });
});

// ── Violation — Python posts here after saving snapshot ──
app.post("/api/violation", (req, res) => {
    const { lane, vehicle, timestamp, image } = req.body;

    const violation = {
        id:        Date.now(),
        lane,
        vehicle,
        timestamp,
        image,
        // ✅ Full URL so frontend (Live Server) can load the image from Node
        imageUrl:  `http://localhost:5000/violations/${image}`,
    };

    currentState.violations.unshift(violation);
    if (currentState.violations.length > 20) currentState.violations.pop();

    console.log(`🚨 VIOLATION | Lane: ${lane} | Vehicle: ${vehicle} | ${timestamp}`);

    // Push to all connected frontends instantly
    io.emit("violation", violation);

    res.json({ ok: true });
});

// ── Manual violation button — frontend triggers this ──
app.post("/api/manual-violation-button", (req, res) => {
    manualTrigger = true;
    res.json({ success: true, message: "Violation trigger set" });
});

// ── Python polls this to check if button was pressed ──
app.get("/api/manual-violation-trigger", (req, res) => {
    res.json({ trigger: manualTrigger });
    manualTrigger = false; // reset after Python reads
});

// =========================
// TRAFFIC CYCLE
// =========================

function startTrafficCycle() {
    if (cycleTimeout) clearTimeout(cycleTimeout);
    runCycle();
}

function runCycle() {

    // EMERGENCY MODE — hold green on emergency lane
    if (currentState.emergency.active) {
        const lane = currentState.emergency.lane;
        currentState.activeLane = lane;
        for (const l of laneOrder) currentState.signals[l] = "red";
        currentState.signals[lane] = "green";
        emitTrafficUpdate();
        cycleTimeout = setTimeout(runCycle, 1000);
        return;
    }

    // AI SAFETY FALLBACK — if Python stops sending data, use simulation
    if (!simulationMode && Date.now() - lastAIUpdate > 5000) {
        console.log("⚠️ AI Timeout → Simulation Mode");
        simulationMode = true;
    }

    // CURRENT LANE
    const currentLane = laneOrder[currentLaneIndex];
    currentState.activeLane = currentLane;

    // TRAFFIC DATA
    const trafficData = simulationMode
        ? generateTrafficData()
        : currentState.counts;

    currentState.counts = trafficData;

    // TIMINGS
    currentState.timings = {
        north: computeGreenTime(trafficData.north),
        south: computeGreenTime(trafficData.south),
        east:  computeGreenTime(trafficData.east),
        west:  computeGreenTime(trafficData.west),
    };

    // SET SIGNALS — all red, then green for active lane
    for (const lane of laneOrder) currentState.signals[lane] = "red";
    currentState.signals[currentLane] = "green";

    const greenTime = currentState.timings[currentLane];
    currentState.greenTime = greenTime;
    currentState.timer     = greenTime;
    currentState.signalRed = false;

    console.log(`🟢 GREEN: ${currentLane} | ${greenTime}s`);

    emitTrafficUpdate();
    io.emit("signalUpdate", {
        activeLane: currentLane,
        greenTime,
        timer:      greenTime,
        signalRed:  false,
    });

    // COUNTDOWN
    let countdown = greenTime;
    const timerInterval = setInterval(() => {
        countdown--;
        currentState.timer = countdown;
        io.emit("signalUpdate", {
            activeLane: currentLane,
            greenTime,
            timer:      countdown,
            signalRed:  false,
        });
        if (countdown <= 0) clearInterval(timerInterval);
    }, 1000);

    // GREEN → YELLOW → NEXT LANE
    cycleTimeout = setTimeout(() => {
        currentState.signals[currentLane] = "yellow";
        console.log(`🟡 YELLOW: ${currentLane}`);
        emitTrafficUpdate();

        cycleTimeout = setTimeout(() => {
            currentState.signalRed = true;
            currentLaneIndex = (currentLaneIndex + 1) % laneOrder.length;
            runCycle();
        }, 3000);

    }, greenTime * 1000);
}

// =========================
// SOCKET CONNECTION
// =========================

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Send full state on connect
    socket.emit("traffic-update", currentState);
    socket.emit("trafficUpdate", {
        A: currentState.counts.north,
        B: currentState.counts.south,
        C: currentState.counts.east,
        D: currentState.counts.west,
    });
    socket.emit("signalUpdate", {
        activeLane: currentState.activeLane,
        greenTime:  currentState.greenTime,
        timer:      currentState.timer,
        signalRed:  currentState.signalRed,
    });

    // Send violation history so page shows past violations on reload
    socket.emit("violationHistory", currentState.violations);

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });

    socket.on("emergency", (data) => {
        io.emit("emergency", data);
    });
});


// =========================
// START
// =========================

startTrafficCycle();

const PORT = 5000;
server.listen(PORT, () => {
    console.log(`🚀 Bismillah — Server running on http://localhost:${PORT}`);
});