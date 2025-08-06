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
const { AudioResampler } = require("avr-resampler");

require("dotenv").config();

// Initialize Express application
const app = express();
// Initialize Audio resampler for 24KHz to 8KHz conversion
let resampler = new AudioResampler(24000);

/**
 * Creates and configures a WebSocket connection to OpenAI's real-time API.
 *
 * @returns {WebSocket} Configured WebSocket instance
 */
const connectToOpenAI = () => {
  const model = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
  return new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
};

/**
 * Stream Processing
 */

/**
 * Handles incoming client audio stream and manages communication with OpenAI's API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 */
const handleAudioStream = async (req, res) => {
  res.setHeader("Content-Type", "application/octet-stream");
  
  let buffer = [];

  const interval = setInterval(() => {
    if (buffer.length > 0) {
      const chunk = buffer.shift();
      res.write(chunk);
    }
  }, 15);

  const openaiWebSocket = connectToOpenAI();

  openaiWebSocket.on("open", () => {
    console.log("WebSocket connected to OpenAI");
    // Initialize session with audio format specifications
    openaiWebSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            process.env.OPENAI_INSTRUCTIONS ||
            "You are a helpful assistant that can answer questions and help with tasks.",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          temperature: +process.env.OPENAI_TEMPERATURE || 0.8,
          max_response_output_tokens: +process.env.OPENAI_MAX_TOKENS || "inf",
        },
      })
    );
  });

  openaiWebSocket.on("message", async (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "error":
          console.error("OpenAI API error:", message.error);
          res.status(500).json({ message: message.error.message });
          break;

        case "session.updated":
          console.log("Session updated:", message);
          break;

        case "response.audio.delta":
          // Clear buffer and start fresh when receiving audio response
          const decoded = Buffer.from(message.delta, "base64");
          const downsampled = resampler.downsample(decoded);
          for (let i = 0; i < downsampled.length; i += 320) {
            const chunk = downsampled.slice(i, i + 320);
            buffer.push(chunk);
          }
          break;

        case "response.audio.done":
          console.log("Audio streaming completed");
          break;

        case "response.audio_transcript.delta":
          // console.log("Transcript delta:", message.delta);
          break;

        case "response.audio_transcript.done":
          console.log("Final transcript:", message.transcript);
          break;

        case "input_audio_buffer.speech_started":
          console.log("Speech started – stopping output stream");
          buffer = [];
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

  // Handle incoming audio data
  req.on("data", async (chunk) => {
    if (openaiWebSocket.readyState === openaiWebSocket.OPEN) {
      const convertedAudio = resampler.upsample(chunk);
      openaiWebSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: convertedAudio.toString("base64"),
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

// API Endpoints
app.post("/speech-to-speech-stream", handleAudioStream);

// Start server
const PORT = process.env.PORT || 6030;
app.listen(PORT, async () => {
  console.log(`OpenAI Speech-to-Speech server running on port ${PORT}`);
  await resampler.initialize();
});
