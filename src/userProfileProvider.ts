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

CONSTRUCT {
    ?person rdf:type schema:Person ;
            schema:name ?name ;
            schema:description ?description ;
            schema:jobTitle ?role ;
            schema:worksFor ?company ;
            schema:employmentStatus ?status ;
            schema:knowsAbout ?expertise ;
            datalatte:hasIntent ?intent .
            
    ?intent rdf:type datalatte:proIntent ;
            schema:description ?intentDesc ;
            datalatte:intentDirection ?direction ;
            datalatte:intentType ?type ;
            datalatte:urgency ?urgency ;
            datalatte:locationPreference ?location ;
            datalatte:budget ?budget .
}
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
        ?intent rdf:type datalatte:proIntent ;
                schema:description ?intentDesc .
        OPTIONAL { ?intent datalatte:intentDirection ?direction }
        OPTIONAL { ?intent datalatte:intentType ?type }
        OPTIONAL { ?intent datalatte:urgency ?urgency }
        OPTIONAL { ?intent datalatte:locationPreference ?location }
        OPTIONAL { ?intent datalatte:budget ?budget }
    }
}`;

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
                const queryResult = await DkgClient.graph.query(userDataQuery, "CONSTRUCT");
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
            if (!userData || Object.keys(userData).length === 0) {
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
Found following information in DKG for @${username} on ${platform}:

\`\`\`json
${JSON.stringify(jsonLd, null, 2)}
\`\`\`
`;
        } catch (error) {
            elizaLogger.error("Error in userProfileProvider:", error);
            return null;
        }
    }
};

export { userProfileProvider }; 