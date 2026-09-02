const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const { GoogleGenAI } = require("@google/genai");

require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;


// ==================================================
// MIDDLEWARE
// ==================================================

app.use(cors());
app.use(express.json());


// ==================================================
// GEMINI AI
// ==================================================

if (!process.env.GEMINI_API_KEY) {
    console.log("WARNING: GEMINI_API_KEY is not configured.");
} else {
    console.log("Gemini API key detected.");
}

const gemini = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});


async function createMissingTables() {

    if (!pool) return;

    try {

        await pool.query(`
            CREATE TABLE IF NOT EXISTS service_requests (
                id SERIAL PRIMARY KEY,
                full_name VARCHAR(255) NOT NULL,
                phone VARCHAR(255) NOT NULL,
                email VARCHAR(255),
                preferred_contact VARCHAR(255),
                service VARCHAR(255),
                preferred_date VARCHAR(255),
                preferred_time VARCHAR(255),
                district VARCHAR(255),
                sector VARCHAR(255),
                address VARCHAR(255),
                details TEXT NOT NULL,
                additional_information TEXT,
                document_url TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS other_service_requests (
                id SERIAL PRIMARY KEY,
                full_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                phone VARCHAR(255) NOT NULL,
                city VARCHAR(255),
                service_type VARCHAR(255) NOT NULL,
                subject VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                company VARCHAR(255),
                availability VARCHAR(255),
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);

        console.log("Database tables verified.");

    } catch (error) {

        console.error("Unable to verify database tables:", error.message);

    }

}


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
        .then(async databaseClient => {

            databaseAvailable = true;

            console.log("================================");
            console.log("      DATABASE CONNECTED");
            console.log("================================");

            await createMissingTables();

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


function getOwnerEmails() {

    const configured = (
        process.env.OWNER_EMAIL ||
        process.env.ADMIN_EMAIL ||
        ""
    )
        .split(",")
        .map(email => email.trim())
        .filter(Boolean);

    return configured.length > 0
        ? configured
        : ["pharma2020luz@gmail.com"];

}


function createMailTransport() {

    if (
        !process.env.SMTP_HOST ||
        !process.env.SMTP_USER ||
        !process.env.SMTP_PASS
    ) {
        return null;
    }

    return nodemailer.createTransport({

        host: process.env.SMTP_HOST,

        port: Number(
            process.env.SMTP_PORT || 587
        ),

        secure:
            String(
                process.env.SMTP_SECURE || "false"
            ) === "true",

        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }

    });

}


async function sendNotificationEmail({
    to,
    subject,
    text,
    html,
    cc
}) {

    const transport = createMailTransport();

    if (!transport) {
        console.log(
            "SMTP is not configured. Email notification skipped."
        );

        return {
            skipped: true,
            reason: "SMTP not configured"
        };
    }

    const from =
        process.env.EMAIL_FROM ||
        process.env.SMTP_USER ||
        "Pharma Luz <noreply@pharmaluz.com>";

    await transport.sendMail({
        from,
        to,
        cc,
        subject,
        text,
        html
    });

    return {
        skipped: false
    };

}


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

                    success: false,

                    error:
                        "Missing message"

                });

            }


            if (!process.env.GEMINI_API_KEY) {

                return res.status(500).json({

                    success: false,

                    error:
                        "GEMINI_API_KEY is not configured."

                });

            }


            const response =
                await gemini.models.generateContent({

                    model: "gemini-3.5-flash",

                    contents: message.trim(),

                    config: {

                        systemInstruction: `
You are PL Assist, the AI assistant for Pharma Luz Ltd.

You help users with:

- Pharma Luz services
- General healthcare information
- Medication information
- Medicine delivery information
- Service requests
- General customer support

Be friendly, professional and easy to understand.

LANGUAGE RULE:
- Automatically detect the language used by the user.
- Reply in the same language as the user's message.
- If the user mixes languages, respond using the language they primarily used.
- Support English, Kinyarwanda, French, Swahili, Spanish, Portuguese, Arabic, Chinese and other languages you understand.
- Do not translate the user's question unless they ask for a translation.
- Keep the response natural and easy to understand.

PHARMA LUZ ROLE:
- Help customers with information about Pharma Luz Ltd.
- Answer questions about pharmacy services, products, availability, and general pharmaceutical information when the necessary information is available.
- Be polite, professional, concise, and helpful.
- Do not invent Pharma Luz products, prices, opening hours, or policies.
- For medical emergencies or serious symptoms, advise the customer to seek professional medical care immediately.
- Do not claim to replace a doctor or pharmacist.

Important safety rules:

- Do not diagnose diseases.
- Do not prescribe medication.
- Do not tell users to start or stop prescription medication.
- Do not replace a qualified healthcare professional.
- For serious medical questions or emergencies, encourage the user to seek appropriate professional medical care.

When users ask about Pharma Luz services, provide helpful information based on the Pharma Luz website, address and many more answers.
Know the exact time and date in Rwanda and provide it when asked.
`

                    }

                });


            res.json({

                success: true,

                reply:
                    response.text

            });


        } catch (error) {

            console.error(
                "AI ERROR:"
            );

            console.error(error);

            res.status(500).json({

                success: false,

                error:
                    "Unable to generate AI response"

            });

        }

    }
);


// ==================================================
// OTHER SERVICE REQUEST
// ==================================================

app.post(
    "/api/other-service-requests",
    async (req, res) => {

        try {

            if (!pool) {

                return res.status(503).json({
                    success: false,
                    error: "Database is not configured yet."
                });

            }

            const {
                fullName,
                email,
                phone,
                city,
                serviceType,
                subject,
                message,
                company,
                availability,
                consent
            } = req.body;

            if (
                !fullName ||
                !email ||
                !phone ||
                !serviceType ||
                !subject ||
                !message ||
                consent !== true
            ) {

                return res.status(400).json({
                    success: false,
                    error: "Please complete all required fields and agree to the confirmation."
                });

            }

            const query = `
                INSERT INTO other_service_requests (
                    full_name,
                    email,
                    phone,
                    city,
                    service_type,
                    subject,
                    message,
                    company,
                    availability,
                    status,
                    created_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW()
                )
                RETURNING id, created_at;
            `;

            const values = [
                fullName.trim(),
                email.trim(),
                phone.trim(),
                city ? city.trim() : null,
                serviceType.trim(),
                subject.trim(),
                message.trim(),
                company ? company.trim() : null,
                availability || null
            ];

            const result = await pool.query(query, values);

            const ownerEmails = getOwnerEmails();

            const ownerHtml = `
                <h2>New Other Service Request</h2>
                <p><strong>Customer:</strong> ${fullName}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Phone:</strong> ${phone}</p>
                <p><strong>Type:</strong> ${serviceType}</p>
                <p><strong>Subject:</strong> ${subject}</p>
                <p><strong>Message:</strong><br>${message.replace(/\n/g, '<br>')}</p>
            `;

            await Promise.allSettled(
                ownerEmails.map(ownerEmail =>
                    sendNotificationEmail({
                        to: ownerEmail,
                        subject: `New ${serviceType} request from ${fullName}`,
                        text: `A new other service request has been received from ${fullName}. Service type: ${serviceType}. Subject: ${subject}.`,
                        html: ownerHtml
                    })
                )
            );

            await sendNotificationEmail({
                to: email,
                subject: "Your request has been received - Pharma Luz",
                text: `Dear ${fullName},\n\nYour ${serviceType} request has been received by Pharma Luz Ltd. Our team will review it and contact you soon.\n\nReference: ${result.rows[0].id}\n\nThank you.`,
                html: `
                    <h2>Request Received</h2>
                    <p>Dear ${fullName},</p>
                    <p>Your <strong>${serviceType}</strong> request has been received by Pharma Luz Ltd.</p>
                    <p>Our team will review your request and contact you soon.</p>
                    <p><strong>Reference:</strong> ${result.rows[0].id}</p>
                    <p>Thank you for contacting us.</p>
                `
            });

            res.status(201).json({
                success: true,
                message: "Your request has been submitted successfully.",
                requestId: result.rows[0].id,
                createdAt: result.rows[0].created_at
            });

        } catch (error) {

            console.error("OTHER SERVICE REQUEST ERROR:", error);

            res.status(500).json({
                success: false,
                error: "Unable to save and notify for this request."
            });

        }

    }
);


app.get(
    "/api/other-service-requests",
    async (req, res) => {

        try {

            if (!pool) {
                return res.status(503).json({
                    success: false,
                    error: "Database is not configured."
                });
            }

            const result = await pool.query(`
                SELECT *
                FROM other_service_requests
                ORDER BY created_at DESC
            `);

            res.json({
                success: true,
                count: result.rows.length,
                requests: result.rows
            });

        } catch (error) {

            console.error("GET OTHER SERVICE REQUESTS ERROR:", error);

            res.status(500).json({
                success: false,
                error: "Unable to retrieve other service requests."
            });

        }

    }
);


app.patch(
    "/api/other-service-requests/:id/status",
    async (req, res) => {

        try {

            if (!pool) {
                return res.status(503).json({
                    success: false,
                    error: "Database is not configured."
                });
            }

            const id = req.params.id;
            const { status, message } = req.body;

            if (!status) {
                return res.status(400).json({
                    success: false,
                    error: "Status is required."
                });
            }

            const statusResult = await pool.query(
                `
                    UPDATE other_service_requests
                    SET status = $1, updated_at = NOW()
                    WHERE id = $2
                    RETURNING *;
                `,
                [status, id]
            );

            if (statusResult.rowCount === 0) {
                return res.status(404).json({
                    success: false,
                    error: "Request not found."
                });
            }

            const request = statusResult.rows[0];

            const emailMessage = message ||
                `Dear ${request.full_name},\n\nYour service request status has been updated to: ${status}.\n\nPharma Luz Ltd will keep you informed with any next steps.\n\nThank you.`;

            await sendNotificationEmail({
                to: request.email,
                subject: `Service request update: ${status}`,
                text: emailMessage,
                html: `<p>Dear ${request.full_name},</p><p>${String(emailMessage).replace(/\n/g, '<br>')}</p>`
            });

            res.json({
                success: true,
                request,
                message: "Status updated and notification sent."
            });

        } catch (error) {

            console.error("UPDATE OTHER SERVICE REQUEST STATUS ERROR:", error);

            res.status(500).json({
                success: false,
                error: "Unable to update status."
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


app.post(
    "/api/service-requests/:id/notify",
    async (req, res) => {

        try {

            if (!pool) {
                return res.status(503).json({
                    success: false,
                    error: "Database is not configured."
                });
            }

            const { id } = req.params;
            const { status, message } = req.body;

            if (!status) {
                return res.status(400).json({
                    success: false,
                    error: "Status is required."
                });
            }

            const result = await pool.query(
                `SELECT * FROM service_requests WHERE id = $1;`,
                [id]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({
                    success: false,
                    error: "Request not found."
                });
            }

            const request = result.rows[0];
            const emailMessage = message ||
                `Dear ${request.full_name},\n\nYour service request is now marked as: ${status}.\n\nPharma Luz Ltd will continue to keep you informed about your service progress.\n\nThank you.`;

            await sendNotificationEmail({
                to: request.email || process.env.OWNER_EMAIL,
                subject: `Service update: ${status}`,
                text: emailMessage,
                html: `<p>Dear ${request.full_name},</p><p>${String(emailMessage).replace(/\n/g, '<br>')}</p>`
            });

            await pool.query(
                `UPDATE service_requests SET status = $1, updated_at = NOW() WHERE id = $2;`,
                [status, id]
            );

            res.json({
                success: true,
                message: "Customer notification sent successfully."
            });

        } catch (error) {

            console.error("SERVICE-REQUEST-NOTIFY ERROR:", error);

            res.status(500).json({
                success: false,
                error: "Unable to send service request notification."
            });

        }

    }
);


app.post(
    "/api/other-service-requests/:id/notify",
    async (req, res) => {

        try {

            if (!pool) {
                return res.status(503).json({
                    success: false,
                    error: "Database is not configured."
                });
            }

            const { id } = req.params;
            const { status, message } = req.body;

            if (!status) {
                return res.status(400).json({
                    success: false,
                    error: "Status is required."
                });
            }

            const result = await pool.query(
                `SELECT * FROM other_service_requests WHERE id = $1;`,
                [id]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({
                    success: false,
                    error: "Request not found."
                });
            }

            const request = result.rows[0];
            const emailMessage = message ||
                `Dear ${request.full_name},\n\nYour request status has been updated to: ${status}.\n\nPharma Luz Ltd will continue to update you on the next steps for your service.\n\nThank you.`;

            await sendNotificationEmail({
                to: request.email,
                subject: `Other service status: ${status}`,
                text: emailMessage,
                html: `<p>Dear ${request.full_name},</p><p>${String(emailMessage).replace(/\n/g, '<br>')}</p>`
            });

            await pool.query(
                `UPDATE other_service_requests SET status = $1, updated_at = NOW() WHERE id = $2;`,
                [status, id]
            );

            res.json({
                success: true,
                message: "Customer notification sent successfully."
            });

        } catch (error) {

            console.error("OTHER-SERVICE-NOTIFY ERROR:", error);

            res.status(500).json({
                success: false,
                error: "Unable to send other service notification."
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