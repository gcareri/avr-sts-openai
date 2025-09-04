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
const axios = require("axios");
const { create } = require("@alexanderolsen/libsamplerate-js");
const { loadTools, getToolHandler } = require("./loadTools");

require("dotenv").config();

// Initialize Express application
const app = express();

const INTERVAL_MS = parseInt(process.env.INTERVAL_MS) || 20;

/**
 * Creates and configures a WebSocket connection to OpenAI's real-time API.
 *
 * @returns {WebSocket} Configured WebSocket instance
 */
const createOpenAIWebSocket = () => {
  const model = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
  return new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
};

/**
 * Fetches custom instructions and tenant ID from external services.
 * Falls back to environment variables if external services are unavailable.
 *
 * @param {string} sessionUuid - Unique session identifier
 * @returns {Promise<{instructions: string, tenantId: string}>} Instructions and tenant ID
 */
async function fetchSessionConfiguration(sessionUuid) {
  let instructions = process.env.OPENAI_INSTRUCTIONS || 
    "You are a helpful assistant that can answer questions and help with tasks.";
  let tenantId = process.env.TENANT_ID || "default";

  try {
    // Fetch variables from AMI service
    const variablesResponse = await axios.post(
      `${process.env.AMI_URL}/variables`,
      { uuid: sessionUuid }
    );

    console.log("Received variables response:", variablesResponse.data);
    if (variablesResponse.data.tenant_id) {
      tenantId = variablesResponse.data.tenant_id;
    } else {
      console.log("No tenant_id found in variables response");
    }

    // Fetch instructions from VitalPBX service
    const vitalpbxResponse = await axios.post(
      `${process.env.VITALPBX_URL}${tenantId}`,
      { uuid: sessionUuid }
    );

    console.log("Received VitalPBX response:", vitalpbxResponse.data);
    if (vitalpbxResponse.data) {
      instructions = vitalpbxResponse.data;
    } else {
      console.log("No instructions found in VitalPBX response");
    }
  } catch (error) {
    console.error("Error fetching session configuration:", error);
  }

  return { instructions, tenantId };
}

/**
 * Handles incoming client audio stream and manages communication with OpenAI's API.
 * Implements audio format conversion and real-time streaming.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 */
const handleAudioStream = async (req, res) => {
  // Initialize audio resamplers for format conversion
  const downsampler = await create(1, 24000, 8000); // 1 channel, 24kHz to 8kHz
  const upsampler = await create(1, 8000, 24000);  // 1 channel, 8kHz to 24kHz
  
  let audioBuffer8k = [];
  let outputBuffer = [];

  /**
   * Processes OpenAI audio chunks by downsampling and extracting frames.
   * Converts 24kHz audio to 8kHz and extracts 20ms frames (160 samples).
   *
   * @param {Buffer} inputBuffer - Raw audio buffer from OpenAI
   * @returns {Buffer[]} Array of 20ms audio frames
   */
  function processOpenAIAudioChunk(inputBuffer) {
    // Convert Buffer to Int16Array for processing
    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2
    );

    // Downsample from 24kHz to 8kHz
    const downsampledSamples = downsampler.full(inputSamples);

    // Accumulate samples in buffer
    audioBuffer8k = audioBuffer8k.concat(Array.from(downsampledSamples));

    // Extract 20ms frames (160 samples = 320 bytes)
    const audioFrames = [];
    while (audioBuffer8k.length >= 160) {
      const frame = audioBuffer8k.slice(0, 160);
      audioBuffer8k = audioBuffer8k.slice(160);

      // Convert to PCM16LE Buffer (320 bytes)
      audioFrames.push(Buffer.from(Int16Array.from(frame).buffer));
    }

    return audioFrames;
  }

  /**
   * Converts 8kHz audio to 24kHz for sending to OpenAI API.
   *
   * @param {Buffer} inputBuffer - 8kHz audio buffer
   * @returns {Buffer} 24kHz audio buffer
   */
  function convert8kTo24k(inputBuffer) {
    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2
    );
    const upsampledSamples = upsampler.full(inputSamples);
    return Buffer.from(Int16Array.from(upsampledSamples).buffer);
  }

  const interval = setInterval(() => {
    if (outputBuffer.length > 0) {
      // Estrai il primo elemento dal buffer
      const chunk = outputBuffer.shift();
      res.write(chunk);
    }
  }, INTERVAL_MS);

  console.log("New audio stream received");
  const sessionUuid = req.headers["x-uuid"];
  console.log("Session UUID:", sessionUuid);

  const openAIWebSocket = createOpenAIWebSocket();

  // Configure WebSocket event handlers
  openAIWebSocket.on("open", async () => {
    console.log("WebSocket connected to OpenAI");

    const { instructions } = await fetchSessionConfiguration(sessionUuid);

    // Initialize session with audio format specifications
    const obj = {
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
    };

    // Load available tools for OpenAI
    try {
      obj.session.tools = loadTools();
      console.log(`Loaded ${obj.session.tools.length} tools for OpenAI`);
    } catch (error) {
      console.error(`Error loading tools for OpenAI: ${error.message}`);
    }

    console.log(obj.session);

    openAIWebSocket.send(JSON.stringify(obj));
  });

  openAIWebSocket.on("message", async (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "error":
          console.error("OpenAI API error:", message.error);
          res.status(500).json({ message: message.error.message });
          break;

        case "session.updated":
          console.log("Session updated successfully");
          break;

        case "response.audio.delta":
          const audioChunk = Buffer.from(message.delta, "base64");
          const audioFrames = processOpenAIAudioChunk(audioChunk);
          outputBuffer = outputBuffer.concat(audioFrames);
          break;

        case "response.audio.done":
          console.log("Audio streaming completed");
          break;
        
        case "response.function_call_arguments.done":
          console.log("Function call arguments streaming completed", message);
          // Get the appropriate handler for the tool
          const handler = getToolHandler(message.name);
          if (!handler) {
            console.error(`No handler found for tool: ${message.name}`);
            return;
          }

          try {
            // Execute the tool handler with the provided arguments
            const content = await handler(
              sessionUuid,
              JSON.parse(message.arguments)
            );
            console.log("Tool response:", content);
            openAIWebSocket.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  instructions: content,
                },
              })
            );
          } catch (error) {
            // Handle errors during tool execution
            console.error(`Error executing tool ${message.name}:`, error);
            return;
          }
          break;

        case "response.audio_transcript.delta":
          // Transcript updates are received but not processed
          break;

        case "response.audio_transcript.done":
          console.log("Final transcript:", message.transcript);
          break;

        case "input_audio_buffer.speech_started":
          console.log("Audio streaming started");
          outputBuffer = [];
          break;

        default:
          console.log("Received message type:", message.type);
          break;
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  });

  openAIWebSocket.on("close", () => {
    console.log("WebSocket connection closed");
    cleanup();
  });

  openAIWebSocket.on("error", (err) => {
    console.error("WebSocket error:", err);
    cleanup();
  });

  /**
   * Cleans up resources and ends the response.
   */
  function cleanup() {
    clearInterval(interval);
    downsampler.destroy();
    upsampler.destroy();
    res.end();
  }

  // Handle incoming audio data from client
  req.on("data", (audioChunk) => {
    const upsampledAudio = convert8kTo24k(audioChunk);
    if (openAIWebSocket.readyState === WebSocket.OPEN) {
      openAIWebSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: upsampledAudio.toString("base64"),
        })
      );
    }
  });

  req.on("end", () => {
    cleanup();
    openAIWebSocket.close();
  });

  req.on("error", (err) => {
    console.error("Request error:", err);
    cleanup();
    openAIWebSocket.close();
  });
};

// API Endpoints
app.post("/speech-to-speech-stream", handleAudioStream);

// Start server
const PORT = process.env.PORT || 6030;
app.listen(PORT, () => {
  console.log(`OpenAI Speech-to-Speech server running on port ${PORT}`);
});
