import {
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    HandlerCallback,
    ActionExample,
    type Action,
    composeContext,
    generateText,
} from "@elizaos/core";

const CONTINUE_TEMPLATE = `
TASK: Generate a natural continuation of the conversation based on the user's profile and recent messages.

Recent Messages:
{{recentMessages}}

Current Profile:
{{currentProfile}}

Rules:
1. Keep responses conversational and friendly
2. Ask relevant follow-up questions about their professional background or goals
3. Guide the conversation towards extracting more profile information
4. If they've shared their intention, acknowledge it and ask for more details
5. If they haven't shared an intention yet, gently probe about their goals

Example Response:
"That's interesting! Could you tell me more about your experience with AI development? I'd love to know what specific areas you're most passionate about."

Output only the response text, no additional formatting.`;

export const continueAction: Action = {
    name: "CONTINUE",
    similes: ["CHAT", "TALK", "CONVERSE"],
    description: "Continues the conversation naturally while gathering professional profile information",

    validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
        return true;
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ): Promise<boolean> => {
        try {
            // Initialize state if needed
            if (!state) {
                state = await runtime.composeState(message);
            }

            // Update recent messages in state
            state = await runtime.updateRecentMessageState(state);

            // Generate continuation response
            const context = composeContext({
                template: CONTINUE_TEMPLATE,
                state: {
                    ...state,
                    currentProfile: JSON.stringify(state.currentProfile, null, 2),
                }
            });

            const response = await generateText({
                runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            if (!response) {
                elizaLogger.warn("Failed to generate continuation response");
                return false;
            }

            callback({
                text: response
            });

            return true;

        } catch (error) {
            elizaLogger.error("Error in continue handler:", error);
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Hi there!",
                    action: "CONTINUE",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "Hello! I'd love to learn more about your professional background. What brings you here today?" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "I work in AI", action: "CONTINUE" },
            },
            {
                user: "{{user2}}",
                content: { text: "That's fascinating! What kind of AI projects are you currently working on?" },
            },
        ]
    ] as ActionExample[][],
} as Action; 