/**
 * index.js
 * Entry point for the OpenAI Speech-to-Speech streaming application.
 * This server handles real-time audio streaming between clients and OpenAI's API,
 * performing necessary audio format conversions and WebSocket communication.
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */

const express = require("express");
const WebSocket = require("ws");
const LibSampleRate = require("@alexanderolsen/libsamplerate-js");

require("dotenv").config();

// ============================================================================
// CONFIGURATION
// ============================================================================

// Audio configuration
const INPUT_RATE = 24000;
const OUTPUT_RATE = 8000;
const BUFFER_INTERVAL_MS = parseInt(process.env.BUFFER_INTERVAL_MS) || 15;
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE) || 320;

// Environment variables with defaults
const PORT = process.env.PORT || 6030;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_INSTRUCTIONS = process.env.OPENAI_INSTRUCTIONS || 
  "You are a helpful assistant that can answer questions and help with tasks.";
const OPENAI_TEMPERATURE = +process.env.OPENAI_TEMPERATURE || 0.8;
const OPENAI_MAX_TOKENS = +process.env.OPENAI_MAX_TOKENS || "inf";

// ============================================================================
// INITIALIZATION
// ============================================================================

// Initialize Express application
const app = express();

// Resampler instances (will be initialized after server starts)
let resamplerDown = null;
let resamplerUp = null;

// ============================================================================
// AUDIO UTILITY FUNCTIONS
// ============================================================================

/**
 * Converts Buffer (pcm16) to Float32Array for audio processing
 * @param {Buffer} buffer - Input PCM16 buffer
 * @returns {Float32Array} Normalized float array
 */
function bufferToFloat32(buffer) {
  const float32 = new Float32Array(buffer.length / 2);
  for (let i = 0; i < float32.length; i++) {
    float32[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return float32;
}

/**
 * Converts Float32Array to Buffer (pcm16) for output
 * @param {Float32Array} floatArray - Input float array
 * @returns {Buffer} PCM16 buffer
 */
function float32ToBuffer(floatArray) {
  const buffer = Buffer.alloc(floatArray.length * 2);
  for (let i = 0; i < floatArray.length; i++) {
    let s = Math.max(-1, Math.min(1, floatArray[i]));
    let intSample = Math.round(s * 32767);
    buffer.writeInt16LE(intSample, i * 2);
  }
  return buffer;
}

// ============================================================================
// OPENAI WEBSOCKET CONNECTION
// ============================================================================

/**
 * Creates and configures a WebSocket connection to OpenAI's real-time API
 * @returns {WebSocket} Configured WebSocket instance
 */
const connectToOpenAI = () => {
  console.log(`Connecting to OpenAI API: wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`);
  
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  return new WebSocket(`wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
};

// ============================================================================
// WEBSOCKET MESSAGE HANDLERS
// ============================================================================

/**
 * Handles OpenAI WebSocket messages and processes audio responses
 * @param {Object} message - Parsed WebSocket message
 * @param {Array} buffer - Audio output buffer
 * @param {Response} res - Express response object
 */
const handleOpenAIMessage = async (message, buffer, res) => {
  try {
    switch (message.type) {
      case "error":
        console.error("OpenAI API error:", message.error);
        res.status(500).json({ message: message.error.message });
        break;

      case "session.updated":
        console.log("Session updated successfully");
        break;

      case "response.audio.delta":
        // Process incoming audio from OpenAI
        const decoded = Buffer.from(message.delta, "base64");
        const floatInput = bufferToFloat32(decoded);
        const resampledFloat = resamplerDown.simple(floatInput);
        const downsampled = float32ToBuffer(resampledFloat);

        // Split into chunks and add to buffer
        for (let i = 0; i < downsampled.length; i += CHUNK_SIZE) {
          buffer.push(downsampled.slice(i, i + CHUNK_SIZE));
        }
        break;

      case "response.audio.done":
        console.log("Audio streaming completed");
        break;

      case "response.audio_transcript.delta":
        // Uncomment for debugging: console.log("Transcript delta:", message.delta);
        break;

      case "response.audio_transcript.done":
        console.log("Final transcript:", message.transcript);
        break;

      case "input_audio_buffer.speech_started":
        console.log("Speech started – clearing output buffer");
        buffer.length = 0; // Clear buffer
        break;

      case "rate_limits.updated":
        console.log("Rate limits updated");
        break;

      default:
        console.log("Received message type:", message.type);
        break;
    }
  } catch (error) {
    console.error("Error processing WebSocket message:", error);
  }
};

// ============================================================================
// MAIN AUDIO STREAM HANDLER
// ============================================================================

/**
 * Handles incoming client audio stream and manages communication with OpenAI's API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 */
const handleAudioStream = async (req, res) => {
  console.log("New audio stream request received");
  
  // Set response headers
  res.setHeader("Content-Type", "application/octet-stream");
  
  // Initialize audio buffer for output
  let buffer = [];

  // Set up interval to send buffered audio to client
  const interval = setInterval(() => {
    if (buffer.length > 0) {
      const chunk = buffer.shift();
      res.write(chunk);
    }
  }, BUFFER_INTERVAL_MS);

  // Connect to OpenAI WebSocket
  const openaiWebSocket = connectToOpenAI();

  // WebSocket event handlers
  openaiWebSocket.on("open", () => {
    console.log("WebSocket connected to OpenAI");
    
    // Initialize session with audio format specifications
    const sessionConfig = {
      type: "session.update",
      session: {
        instructions: OPENAI_INSTRUCTIONS,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        temperature: OPENAI_TEMPERATURE,
        max_response_output_tokens: OPENAI_MAX_TOKENS,
      },
    };
    
    console.log("Sending session configuration to OpenAI");
    openaiWebSocket.send(JSON.stringify(sessionConfig));
  });

  openaiWebSocket.on("message", async (data) => {
    const message = JSON.parse(data);
    await handleOpenAIMessage(message, buffer, res);
  });

  openaiWebSocket.on("close", async () => {
    console.log("WebSocket connection closed");
    clearInterval(interval);
    res.end();
  });

  openaiWebSocket.on("error", async (err) => {
    console.error("WebSocket error:", err);
    clearInterval(interval);
    res.end();
  });

  // Handle incoming audio data from client
  req.on("data", async (chunk) => {
    if (openaiWebSocket.readyState === WebSocket.OPEN) {
      // Convert and upsample audio
      const floatInput = bufferToFloat32(chunk);
      const resampledFloat = resamplerUp.simple(floatInput);
      const upsampled = float32ToBuffer(resampledFloat);

      // Send to OpenAI
      openaiWebSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: upsampled.toString("base64"),
        })
      );
    }
  });

  req.on("end", async () => {
    console.log("Request stream ended");
    clearInterval(interval);
    openaiWebSocket.close();
  });

  req.on("error", async (err) => {
    console.error("Request error:", err);
    clearInterval(interval);
    openaiWebSocket.close();
  });
};

// ============================================================================
// API ENDPOINTS
// ============================================================================

app.post("/speech-to-speech-stream", handleAudioStream);

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================

/**
 * Initialize resamplers for audio format conversion
 */
const initializeResamplers = async () => {
  try {
    console.log("Initializing audio resamplers...");
    
    // Downsampler: 24kHz -> 8kHz
    resamplerDown = await LibSampleRate.create(1, INPUT_RATE, OUTPUT_RATE, {
      converterType: LibSampleRate.ConverterType.SRC_SINC_BEST_QUALITY,
    });
    
    // Upsampler: 8kHz -> 24kHz
    resamplerUp = await LibSampleRate.create(1, OUTPUT_RATE, INPUT_RATE, {
      converterType: LibSampleRate.ConverterType.SRC_SINC_BEST_QUALITY,
    });

    console.log("Resamplers initialized successfully");
    console.log(`Input rate: ${INPUT_RATE}Hz, Output rate: ${OUTPUT_RATE}Hz`);
  } catch (error) {
    console.error("Failed to initialize resamplers:", error);
    process.exit(1);
  }
};

// Start server
app.listen(PORT, async () => {
  console.log(`OpenAI Speech-to-Speech server running on port ${PORT}`);
  
  // Initialize resamplers after server starts
  await initializeResamplers();
});
