import { Provider, IAgentRuntime, Memory, State, elizaLogger } from "@elizaos/core";
// @ts-ignore
import DKG from "dkg.js";

let DkgClient: any = null;

// SPARQL query to find structured user data
const USER_DATA_QUERY = `
PREFIX schema: <http://schema.org/>
PREFIX datalatte: <https://datalatte.com/ns/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT ?person ?name ?description ?role ?company ?status ?expertise ?intent 
       (MAX(?intentDesc) AS ?latestDesc)
       (MAX(?intentDir) AS ?latestDir)
       (MAX(?intentType) AS ?latestType)
       (GROUP_CONCAT(?prefs; SEPARATOR=",") AS ?allPrefs)
WHERE {
    ?person rdf:type schema:Person ;
            foaf:account ?account .
    ?account a foaf:OnlineAccount ;
             foaf:accountServiceHomepage "{{platform}}" ;
             foaf:accountName "{{username}}" .
             
    OPTIONAL { ?person schema:name ?name }
    OPTIONAL { ?person schema:description ?description }
    OPTIONAL { ?person schema:jobTitle ?role }
    OPTIONAL { ?person schema:worksFor ?company }
    OPTIONAL { ?person schema:employmentStatus ?status }
    OPTIONAL { ?person schema:knowsAbout ?expertise }
    
    OPTIONAL {
        ?person datalatte:hasIntent ?intent .
        ?intent rdf:type datalatte:intent ;
                datalatte:intentCategory "professional" ;
                schema:description ?intentDesc ;
                datalatte:intentDirection ?intentDir ;
                datalatte:intentType ?intentType .
        OPTIONAL { ?intent datalatte:hasPreferences ?prefs }
    }
}
GROUP BY ?person ?name ?description ?role ?company ?status ?expertise ?intent
ORDER BY DESC(?intent)
`;

const userProfileProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<string | null> => {
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
            let platform = client?.constructor?.name?.replace('ClientInterface', '').toLowerCase();
            if (platform?.endsWith('client')) {
                platform = platform.replace('client', '');
            }

            elizaLogger.info("Checking DKG for user data:", {
                username,
                platform,
                clientType: client?.constructor?.name
            });

            // Query for user data
            const userDataQuery = USER_DATA_QUERY
                .replace("{{platform}}", platform)
                .replace("{{username}}", username);

            let userData;
            try {
                const queryResult = await DkgClient.graph.query(userDataQuery, "SELECT");
                elizaLogger.info("User data query result:", {
                    status: queryResult.status,
                    data: queryResult.data
                });
                
                userData = queryResult.data;
            } catch (error) {
                elizaLogger.error("Error querying user data:", error);
                return null;
            }

            // If no data found
            if (!userData || userData.length === 0) {
                return `No profile information found in DKG for @${username} on ${platform}.`;
            }

            // Format the found data as JSON-LD
            const jsonLd = {
                "@context": {
                    "schema": "http://schema.org/",
                    "datalatte": "https://datalatte.com/ns/",
                    "foaf": "http://xmlns.com/foaf/0.1/"
                },
                "@graph": userData
            };

            return `
Profile for @${username} collected through ${platform} interactions:

\`\`\`json
${JSON.stringify(jsonLd, null, 2)}
\`\`\`
Task: Based on users recent conversation and the avaialble intentions, engage in a natural conversation to ask follow up questions to get information that helps finding a better match for the intent user is looking for currently in the conversation.
`;
        } catch (error) {
            elizaLogger.error("Error in userProfileProvider:", error);
            return null;
        }
    }
};

export { userProfileProvider }; 