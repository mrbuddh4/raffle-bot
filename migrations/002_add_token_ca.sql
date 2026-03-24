-- Add token_ca column to raffles table to store custom token contract addresses
ALTER TABLE raffles
ADD COLUMN token_ca VARCHAR(255);

-- Create an index on token_ca for efficient lookups
CREATE INDEX idx_raffles_token_ca ON raffles(token_ca);
