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
  generateObjectArray,
} from "@elizaos/core";
// @ts-ignore
import DKG from "dkg.js";

let DkgClient: any = null;

// SPARQL query to find existing professional intentions for a user
const EXISTING_INTENTIONS_QUERY = `
PREFIX schema: <http://schema.org/>
PREFIX datalatte: <https://datalatte.com/ns/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>

SELECT ?intent ?description ?direction ?type
WHERE {
  {
    SELECT ?intent (SAMPLE(?description) as ?description) (SAMPLE(?direction) as ?direction) (SAMPLE(?type) as ?type)
    WHERE {
      ?person a schema:Person ;
              foaf:account ?account .
      ?account a foaf:OnlineAccount ;
               foaf:accountServiceHomepage "{{platform}}" ;
               foaf:accountName "{{username}}" .
      ?person datalatte:hasIntent ?intent .
      ?intent a datalatte:intent ;
              datalatte:intentCategory "professional" ;
              schema:description ?description ;
              datalatte:intentDirection ?direction ;
              datalatte:intentType ?type .
    }
    GROUP BY ?intent
    ORDER BY DESC(?intent)
  }
}`;

const KGExtractionTemplate = `
TASK: Transform conversation data into valid schema.org/FOAF compliant JSON-LD for professional intentions, considering existing intentions in DKG

Recent Messages:
{{recentMessages}}

Existing Intentions in DKG:
{{existingIntentions}}

SHACL Shapes for Validation:
{
  "@context": {
    "sh": "http://www.w3.org/ns/shacl#",
    "schema": "http://schema.org/",
    "datalatte": "https://datalatte.com/ns/",
    "xsd": "http://www.w3.org/2001/XMLSchema#"
  },
  "@type": "sh:NodeShape",
  "sh:targetClass": "datalatte:intent",
  "sh:property": [
    {
      "sh:path": "schema:description",
      "sh:datatype": "xsd:string",
      "sh:minCount": 1,
      "sh:maxCount": 1
    },
    {
      "sh:path": "schema:url",
      "sh:datatype": "xsd:anyURI",
      "sh:maxCount": 1
    },
    {
      "sh:path": "datalatte:intentDirection",
      "sh:in": ["seeking", "offering", "bidirectional"],
      "sh:minCount": 1,
      "sh:maxCount": 1
    },
    {
      "sh:path": "datalatte:intentType",
      "sh:in": [
        "mentorship",
        "networking",
        "collaboration",
        "hiring",
        "jobSearch",
        "funding",
        "investment",
        "startupGrowth",
        "skillDevelopment",
        "consulting",
        "speakingOpportunity",
        "projectPartnership",
        "businessDevelopment",
        "coaching",
        "professionalTraining",
        "advisory"
      ],
      "sh:minCount": 1,
      "sh:maxCount": 1
    },
    {
      "sh:path": "datalatte:intentCategory",
      "sh:in": ["professional"],
      "sh:minCount": 1,
      "sh:maxCount": 1
    },
    {
      "sh:path": "datalatte:hasPreferences",
      "sh:node": {
        "sh:property": [
          {
            "sh:path": "datalatte:requiredSkills",
            "sh:datatype": "xsd:string",
            "sh:maxCount": 10
          },
          {
            "sh:path": "datalatte:preferredIndustries",
            "sh:datatype": "xsd:string",
            "sh:maxCount": 5
          },
          {
            "sh:path": "datalatte:experienceLevel",
            "sh:in": ["entry", "mid", "senior", "executive"],
            "sh:maxCount": 1
          },
          {
            "sh:path": "datalatte:remotePreference",
            "sh:in": ["onsite", "remote", "hybrid"],
            "sh:maxCount": 1
          },
          {
            "sh:path": "datalatte:contractType",
            "sh:in": ["full-time", "part-time", "freelance", "internship", "contract"],
            "sh:maxCount": 1
          },
          {
            "sh:path": "datalatte:companySize",
            "sh:in": ["startup", "small", "medium", "large"],
            "sh:maxCount": 1
          }
        ]
      }
    }
  ]
}

Guidelines:
1. First analyze if the intention from conversation matches or updates any existing intention:
   - If exact match exists (same core intention, no new details) -> return empty array
   - If similar intention exists but has new details -> use existing intention ID and merge details
   - If completely new intention -> use the provided new intention ID
2. For existing intention updates:
   - Keep all existing fields
   - Only add or update fields that have new information
   - Use the exact intention ID from the matching existing intention
3. For new intentions:
   - Use the provided new intention ID
   - Fill all fields that can be extracted from conversation
4. All fields must match their defined datatypes and value constraints
5. Required fields (description, intentDirection, intentType, intentCategory) must be present
6. Budget and timeline information should be extracted if present in conversation
7. Some "intentionTypes" has ONLY bidirectional "intentDirection" such as "networking", "collaboration", "projectPartnership"

Format response as array:
[
  {
    "analysis": {
      "matchType": "exact_match" | "update_existing" | "new_intention",
      "existingIntentionId": "<id of matching intention if update_existing>",
      "reason": "<explanation of the decision>"
    },
    "public": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/"
      },
      "@type": "datalatte:intent",
      "@id": "urn:intent:{{intentid}}",
      "schema:description": "<extract from conversation>",
      "schema:url": "<extract URL if mentioned>",
      "datalatte:intentDirection": "<seeking|offering|bidirectional>",
      "datalatte:intentType": "<one of the allowed types>",
      "datalatte:intentCategory": "professional",
      "datalatte:hasPreferences": {
        "datalatte:requiredSkills": ["<skill1>", "<skill2>", ...],
        "datalatte:preferredIndustries": ["<industry1>", "<industry2>", ...],
        "datalatte:experienceLevel": "<entry|mid|senior|executive>",
        "datalatte:remotePreference": "<onsite|remote|hybrid>",
        "datalatte:contractType": "<full-time|part-time|freelance|internship|contract>",
        "datalatte:companySize": "<startup|small|medium|large>"
      }
    },
    "private": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/",
        "foaf": "http://xmlns.com/foaf/0.1/"
      },
      "@type": "schema:Person",
      "@id": "urn:uuid:{{uuid}}",
      "foaf:account": {
        "@type": "foaf:OnlineAccount",
        "foaf:accountServiceHomepage": "{{platform}}",
        "foaf:accountName": "{{username}}"
      },
      "datalatte:hasIntent": {
        "@type": "datalatte:intent",
        "@id": "urn:intent:{{intentid}}",
        "datalatte:budget": {
          "datalatte:amount": "<number>",
          "datalatte:currency": "<currency code>",
          "datalatte:frequency": "<hourly|monthly|project-based>"
        },
        "datalatte:timeline": {
          "datalatte:startDate": "<YYYY-MM-DD>",
          "datalatte:flexibility": "<fixed|flexible>"
        },
        "datalatte:urgency": "<low|medium|high>"
      }
    }
  }
]

- If exact match exists or no clear intention found, return []
- If updating existing intention, use that intention's ID instead of {{intentid}}
- Exclude any field from the output if not found in conversation
`;

export const publishProIntent2Dkg: Action = {
  name: "PUBLISH_DKG_INTENT_PROFESSIONAL",
  similes: ["PUBLISH_INTENTION_TO_DKG", "SAVE_INTENTION_TO_DKG", "STORE_INTENTION_IN_DKG"],
  description: "Publishes professional intentions to the OriginTrail Decentralized Knowledge Graph",

  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const requiredEnvVars = [
      "DKG_ENVIRONMENT",
      "DKG_HOSTNAME",
      "DKG_PORT",
      "DKG_BLOCKCHAIN_NAME",
      "DKG_PUBLIC_KEY",
      "DKG_PRIVATE_KEY",
    ];

    const missingVars = requiredEnvVars.filter((varName) => !runtime.getSetting(varName));

    if (missingVars.length > 0) {
      elizaLogger.error(`Missing required environment variables: ${missingVars.join(", ")}`);
      return false;
    }

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
      // Initialize DKG client if needed
      if (!DkgClient) {
        DkgClient = new DKG({
          environment: runtime.getSetting("DKG_ENVIRONMENT"),
          endpoint: runtime.getSetting("DKG_HOSTNAME"),
          port: runtime.getSetting("DKG_PORT"),
          blockchain: {
            name: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
            publicKey: runtime.getSetting("DKG_PUBLIC_KEY"),
            privateKey: runtime.getSetting("DKG_PRIVATE_KEY"),
          },
          maxNumberOfRetries: 300,
          frequency: 2,
          contentType: "all",
          nodeApiVersion: "/v1",
        });
      }

      const username = state?.senderName || message.userId;

      // Get platform type from client
      const clients = runtime.clients;
      const client = Object.values(clients)[0];
      let platform = client?.constructor?.name?.replace("ClientInterface", "").toLowerCase();
      if (platform?.endsWith("client")) {
        platform = platform.replace("client", "");
      }

      elizaLogger.info("User platform details:", {
        username,
        platform,
        clientType: client?.constructor?.name,
      });

      // First, check for existing professional intentions in DKG
      const existingIntentionsQuery = EXISTING_INTENTIONS_QUERY.replace("{{platform}}", platform).replace(
        "{{username}}",
        username
      );

      elizaLogger.info("Querying for existing professional intentions:", {
        query: existingIntentionsQuery,
      });

      let existingIntentions;
      try {
        // Add a small delay to allow for DKG indexing if needed
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const queryResult = await DkgClient.graph.query(existingIntentionsQuery, "SELECT");
        elizaLogger.info("Existing intentions query result:", {
          status: queryResult.status,
          dataLength: queryResult.data?.length,
          data: queryResult.data,
        });

        existingIntentions = queryResult.data;
      } catch (error) {
        elizaLogger.error("Error querying existing intentions:", error);
        existingIntentions = [];
      }

      // Update state with recent messages and existing intentions
      if (!state) {
        state = await runtime.composeState(message);
      }
      state = await runtime.updateRecentMessageState(state);

      // Generate a new intention ID that will only be used if needed
      const newIntentionId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      state.intentid = newIntentionId; // This may be replaced by an existing ID
      state.uuid = message.userId;
      state.platform = platform;
      state.username = username;
      state.existingIntentions = JSON.stringify(existingIntentions || [], null, 2);

      elizaLogger.info("Generating JSON-LD with context data:", {
        messageId: message.id,
        platform,
        username,
        newIntentionId,
        existingIntentionsCount: existingIntentions?.length || 0,
      });

      const context = composeContext({
        template: KGExtractionTemplate,
        state,
      });

      elizaLogger.info("=== Full KG Extraction Template Prompt ===");
      elizaLogger.info("Template:", {
        fullPrompt: context,
        stateData: {
          recentMessages: state.recentMessages,
          uuid: state.uuid,
          intentid: state.intentid,
          platform: state.platform,
          username: state.username,
          existingIntentions: state.existingIntentions,
        },
      });
      elizaLogger.info("=====================================");

      const result = await generateObjectArray({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
      });

      if (!result || result.length === 0) {
        elizaLogger.info("No professional intention to publish - empty result");
        callback({
          text: "I found that this professional intention is already published in the DKG. No changes needed!",
        });
        return true;
      }

      const firstResult = result[0];
      const analysis = firstResult.analysis;
      elizaLogger.info("Professional intention analysis:", analysis);

      if (analysis.matchType === "exact_match") {
        elizaLogger.info("Exact match found - no updates needed");
        callback({
          text: "I found that this professional intention is already published in the DKG. No changes needed!",
        });
        return true;
      }

      // If it's an update to an existing intention, use that ID
      if (analysis.matchType === "update_existing" && analysis.existingIntentionId) {
        state.intentid = analysis.existingIntentionId;
        elizaLogger.info("Updating existing professional intention:", {
          existingId: analysis.existingIntentionId,
          reason: analysis.reason,
        });
      }

      const { public: publicJsonLd, private: privateJsonLd } = firstResult;

      elizaLogger.info("=== Generated JSON-LD for DKG ===");
      elizaLogger.info("Public JSON-LD:", {
        data: publicJsonLd,
      });
      elizaLogger.info("Private JSON-LD:", {
        data: JSON.stringify(privateJsonLd, null, 2),
      });
      elizaLogger.info("================================");

      // Publish to DKG
      elizaLogger.info("Publishing professional intention to DKG with client config:", {
        environment: runtime.getSetting("DKG_ENVIRONMENT"),
        endpoint: runtime.getSetting("DKG_HOSTNAME"),
        port: runtime.getSetting("DKG_PORT"),
        blockchain: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
      });

      let createAssetResult;
      try {
        elizaLogger.info("Initializing DKG asset creation...");

        createAssetResult = await DkgClient.asset.create(
          {
            public: publicJsonLd,
            private: privateJsonLd,
          },
          { epochsNum: 3 } // keeping this intention in the DKG for 3 months only
        );

        elizaLogger.info("DKG asset creation request completed successfully");
        elizaLogger.info("=== Knowledge Asset Created ===");
        elizaLogger.info(`UAL: ${createAssetResult.UAL}`);
        elizaLogger.info(
          `DKG Explorer Link: ${
            runtime.getSetting("DKG_ENVIRONMENT") === "mainnet"
              ? "https://dkg.origintrail.io/explore?ual="
              : "https://dkg-testnet.origintrail.io/explore?ual="
          }${createAssetResult.UAL}`
        );
        elizaLogger.info("===============================");

        callback({
          text: `Successfully published your professional intent to DKG!\nView it here: ${
            runtime.getSetting("DKG_ENVIRONMENT") === "mainnet"
              ? "https://dkg.origintrail.io/explore?ual="
              : "https://dkg-testnet.origintrail.io/explore?ual="
          }${createAssetResult.UAL}`,
        });

        return true;
      } catch (error) {
        elizaLogger.error("Error occurred while publishing professional intention to DKG:", error.message);
        if (error.stack) {
          elizaLogger.error("Stack trace:", error.stack);
        }
        if (error.response) {
          elizaLogger.error("Response data:", JSON.stringify(error.response.data, null, 2));
        }
        return false;
      }
    } catch (error) {
      elizaLogger.error("Error in publishProIntent2Dkg handler:", error);
      return false;
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "I'd prefer to work with professionals from the US or Canada, especially those with a background in Ethereum.",
          action: "PUBLISH_DKG_INTENT_PROFESSIONAL",
        },
      },
      {
        user: "DataBarista",
        content: { text: "Great! Your intent has been published on DKG: https://dkg.origintrail.io/explore?ual={UAL} (SERENDIPITY)" },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "One more detail: I'm looking for professionals with a background in risk management and smart contract auditing.",
          action: "PUBLISH_DKG_INTENT_PROFESSIONAL",
        },
      },
      {
        user: "DataBarista",
        content: { text: "Great! Your intent has been published on DKG: https://dkg.origintrail.io/explore?ual={UAL} (SERENDIPITY)"},
      },
    ]
  ] as ActionExample[][],
} as Action;
