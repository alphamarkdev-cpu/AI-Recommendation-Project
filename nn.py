# pip install google-genai python-dotenv
import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

prompt = "The quick brown fox jumps over the lazy dog."

response = client.models.count_tokens(
    model="gemini-2.5-flash",
    contents=prompt
)

print("Total Input Tokens:", response.total_tokens)