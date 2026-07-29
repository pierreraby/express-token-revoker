// Desc: Middleware to check if the user is authenticated
import jwt from "jsonwebtoken";
import logger from "#logger";

// Verify the JWT token
export const auth = (req, res, next) => {
  try {
    const token = req.headers.authorization.split(" ")[1];
    req.token = jwt.verify(token, process.env.JWT_SECRET_KEY);
    next();
  } catch (error) {
    res.status(401).json({message: `Invalid token Auth! ${ error }`});
  }
};

// Verify the JWT token and check if the user is an admin
export const admin = (req, res, next) => {
  try {
    const token = req.headers.authorization.split(" ")[1];
    req.token = jwt.verify(token, process.env.JWT_SECRET_KEY);
    if (!req.token.admin) {
      throw new Error('You are not an admin');
    }
    next();
  } catch (error) {
    logger.info(`Invalid token ! ${ error }`);
    res.status(401).json({message: `Invalid token ! ${ error }`});
  }
};