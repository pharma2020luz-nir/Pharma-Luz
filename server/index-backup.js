const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");

require("dotenv").config();

const OpenAI = require("openai");

const app = express();

const PORT = process.env.PORT || 3000;


// ==================================================
// MIDDLEWARE
// ==================================================

app.use(cors());

app.use(express.json());


// ==================================================
// OPENAI
// ==================================================

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});


// ==================================================
// POSTGRESQL
// ==================================================

let pool = null;

let databaseAvailable = false;

if (process.env.DATABASE_URL) {

    pool = new Pool({
        connectionString: process.env.DATABASE_URL,

        ssl:
            process.env.NODE_ENV === "production"
                ? { rejectUnauthorized: false }
                : false
    });

    pool.connect()
        .then(databaseClient => {

            databaseAvailable = true;

            console.log("================================");
            console.log("      DATABASE CONNECTED");
            console.log("================================");

            databaseClient.release();

        })
        .catch(error => {

            console.log("DATABASE CONNECTION ERROR:");
            console.log(error.message);

        });

} else {

    console.log("DATABASE_URL is not configured.");
    console.log("PostgreSQL is currently disabled.");

}


// ==================================================
// UPLOADS
// ==================================================

const uploadDirectory =
    path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDirectory)) {

    fs.mkdirSync(
        uploadDirectory,
        {
            recursive: true
        }
    );

}


const storage = multer.diskStorage({

    destination: function (req, file, cb) {

        cb(
            null,
            uploadDirectory
        );

    },

    filename: function (req, file, cb) {

        const extension =
            path.extname(file.originalname);

        const filename =
            Date.now() +
            "-" +
            Math.round(Math.random() * 1000000) +
            extension;

        cb(
            null,
            filename
        );

    }

});


const fileFilter = function (
    req,
    file,
    cb
) {

    const allowedTypes = [
        "application/pdf",
        "image/jpeg",
        "image/png"
    ];

    if (
        allowedTypes.includes(
            file.mimetype
        )
    ) {

        cb(null, true);

    } else {

        cb(
            new Error(
                "Only PDF, JPG, JPEG and PNG files are allowed."
            )
        );

    }

};


const upload = multer({

    storage: storage,

    fileFilter: fileFilter,

    limits: {
        fileSize: 5 * 1024 * 1024
    }

});


// ==================================================
// HEALTH
// ==================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            status: "ok",

            message:
                "PL Assist backend is running",

            database:
                databaseAvailable
                    ? "connected"
                    : "not connected"

        });

    }
);


// ==================================================
// DATABASE TEST
// ==================================================

app.get(
    "/database",
    async (req, res) => {

        if (!pool) {

            return res.status(503).json({

                status: "error",

                message:
                    "DATABASE_URL is not configured."

            });

        }

        try {

            const result =
                await pool.query(
                    "SELECT NOW() AS current_time"
                );

            databaseAvailable = true;

            res.json({

                status: "ok",

                message:
                    "PostgreSQL database is connected",

                time:
                    result.rows[0].current_time

            });

        } catch (error) {

            console.error(
                "DATABASE ERROR:",
                error.message
            );

            res.status(500).json({

                status: "error",

                message:
                    "Database connection failed"

            });

        }

    }
);


// ==================================================
// PL ASSIST AI
// ==================================================

app.post(
    "/chat",
    async (req, res) => {

        try {

            const {
                message
            } = req.body;

            if (
                !message ||
                typeof message !== "string" ||
                !message.trim()
            ) {

                return res.status(400).json({

                    error:
                        "Missing message"

                });

            }

            if (!process.env.OPENAI_API_KEY) {

                return res.status(500).json({

                    error:
                        "OPENAI_API_KEY is not configured."

                });

            }


            const response =
                await openai.responses.create({

                    model: "gpt-5-mini",

                    instructions: `
You are PL Assist, the AI assistant for Pharma Luz Ltd.

You help users with:

- Pharma Luz services
- General healthcare information
- Medication information
- Medicine delivery information
- Service requests
- General customer support

Be friendly, professional and easy to understand.

Important safety rules:

- Do not diagnose diseases.
- Do not prescribe medication.
- Do not tell users to start or stop prescription medication.
- Do not replace a qualified healthcare professional.
- For serious medical questions or emergencies, encourage the user to seek appropriate professional medical care.

When users ask about Pharma Luz services, provide helpful information based on the Pharma Luz website.
`,

                    input: message.trim()

                });


            res.json({

                success: true,

                reply:
                    response.output_text

            });


        } catch (error) {

            console.error(
                "AI ERROR:"
            );

            console.error(
                error
            );

            res.status(500).json({

                success: false,

                error:
                    "Unable to generate AI response"

            });

        }

    }
);


// ==================================================
// SERVICE REQUEST
// ==================================================

app.post(
    "/api/service-requests",
    upload.single("document"),

    async (req, res) => {

        try {

            if (!pool) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database is not configured yet."

                });

            }


            const {

                fullName,
                phone,
                email,
                preferredContact,
                service,
                preferredDate,
                preferredTime,
                district,
                sector,
                address,
                details,
                reference

            } = req.body;


            if (
                !fullName ||
                !phone ||
                !service ||
                !details
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Missing required fields."

                });

            }


            let documentUrl = null;

            if (req.file) {

                documentUrl =
                    `/uploads/${req.file.filename}`;

            }


            const query = `

                INSERT INTO service_requests (

                    full_name,
                    phone,
                    email,
                    preferred_contact,
                    service,
                    preferred_date,
                    preferred_time,
                    district,
                    sector,
                    address,
                    details,
                    additional_information,
                    document_url,
                    status

                )

                VALUES (

                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    $11,
                    $12,
                    $13,
                    'pending'

                )

                RETURNING id, created_at;

            `;


            const values = [

                fullName.trim(),

                phone.trim(),

                email
                    ? email.trim()
                    : null,

                preferredContact || null,

                service,

                preferredDate || null,

                preferredTime || null,

                district
                    ? district.trim()
                    : null,

                sector
                    ? sector.trim()
                    : null,

                address
                    ? address.trim()
                    : null,

                details.trim(),

                reference
                    ? reference.trim()
                    : null,

                documentUrl

            ];


            const result =
                await pool.query(
                    query,
                    values
                );


            res.status(201).json({

                success: true,

                message:
                    "Your service request has been received successfully.",

                requestId:
                    result.rows[0].id,

                createdAt:
                    result.rows[0].created_at

            });


        } catch (error) {

            console.error(
                "SERVICE REQUEST ERROR:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    "Unable to save service request"

            });

        }

    }
);


// ==================================================
// GET SERVICE REQUESTS
// ==================================================

app.get(
    "/api/service-requests",
    async (req, res) => {

        try {

            if (!pool) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database is not configured."

                });

            }


            const result =
                await pool.query(`

                    SELECT *

                    FROM service_requests

                    ORDER BY created_at DESC

                `);


            res.json({

                success: true,

                count:
                    result.rows.length,

                requests:
                    result.rows

            });


        } catch (error) {

            console.error(
                "GET SERVICE REQUESTS ERROR:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    "Unable to retrieve service requests"

            });

        }

    }
);


// ==================================================
// SERVE UPLOADED FILES
// ==================================================

app.use(
    "/uploads",
    express.static(uploadDirectory)
);


// ==================================================
// ERROR HANDLER
// ==================================================

app.use(
    (error, req, res, next) => {

        if (
            error instanceof multer.MulterError
        ) {

            return res.status(400).json({

                success: false,

                error:
                    "File upload error: " +
                    error.message

            });

        }


        if (error) {

            return res.status(400).json({

                success: false,

                error:
                    error.message

            });

        }


        next();

    }
);


// ==================================================
// START SERVER
// ==================================================

app.listen(
    PORT,
    () => {

        console.log("");

        console.log(
            "================================"
        );

        console.log(
            "       PL ASSIST AI SERVER"
        );

        console.log(
            "================================"
        );

        console.log(
            `Server: http://localhost:${PORT}`
        );

        console.log(
            `Chat:   http://localhost:${PORT}/chat`
        );

        console.log(
            `Health: http://localhost:${PORT}/health`
        );

        console.log(
            `DB:     http://localhost:${PORT}/database`
        );

        console.log(
            `Service: http://localhost:${PORT}/api/service-requests`
        );

        console.log(
            "================================"
        );

        console.log("");

    }
);