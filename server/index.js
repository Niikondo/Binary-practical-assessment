const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');


mongoose.connect('mongodb://localhost:27017/binary');
const app = express();
 
app.use(cors());
app.use(express.json());

const UserSchema = new mongoose.Schema({
  name: String,
  clientCode: String,
  no_of_linked_contacts: Number,
});

const ContactsSchema = new mongoose.Schema({
  name: String,
  surname: String,
  email: String,
  no_of_linked_clients: Number,
});

const LinkSchema = new mongoose.Schema({
  clientCode: {
    type: String,
    ref: 'clients', // Reference to the User (Client) collection
  },
  email: {
    type: String,
    ref: 'contacts', // Reference to the Contacts collection
  },
});

const ContactsModel = mongoose.model('contacts',ContactsSchema);
const UserModel = mongoose.model('clients',UserSchema);
const LinkModel = mongoose.model('links', LinkSchema);


app.post('/save-link', async (req, res) => {
  try {
    const { clientCodes, email } = req.body;

    // Check if the provided contact exists
    const contact = await ContactsModel.findOne({ email });
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found for email: ' + email });
    }

    // Save links for each client code
    const savedLinks = [];

    for (const clientCode of clientCodes) {
      // Check if the provided client exists
      const client = await UserModel.findOne({ clientCode });

      if (!client) {
        // Handle the case where the client is not found
        console.error('Client not found for clientCode:', clientCode);
        continue;  // Skip to the next iteration
      }

      // Check if a link already exists
      const existingLink = await LinkModel.findOne({ clientCode: client._id, email: contact._id });

      if (existingLink) {
        // Handle the case where the link already exists
        console.warn('Link already exists for clientCode:', clientCode);
        continue;  // Skip to the next iteration
      }

      // Save the link to the Link collection
      const link = new LinkModel({ clientCode: client._id, email: contact._id });
      const savedLink = await link.save();
      savedLinks.push(savedLink);

      // Update the no_of_linked_contacts and no_of_linked_clients fields
      const countLinkedContacts = await LinkModel.countDocuments({ email: contact._id });
      const countLinkedClients = await LinkModel.countDocuments({ clientCode: client._id });

      await UserModel.updateOne({ _id: client._id }, { $set: { no_of_linked_contacts: countLinkedClients } });
      await ContactsModel.updateOne({ _id: contact._id }, { $set: { no_of_linked_clients: countLinkedContacts } });
      await fetch('http://localhost:3000/update-link-counts');
    }

    res.status(201).json({ message: 'Links saved successfully', savedLinks });
  } catch (error) {
    console.error('Error saving links:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/update-link-counts', async (req, res) => {
  try {
    // Fetch all links
    const links = await LinkModel.find();

    // Calculate and update no_of_linked_contacts and no_of_linked_clients for each entry
    for (const link of links) {
      const countLinkedContacts = await LinkModel.countDocuments({ email: link.email });
      const countLinkedClients = await LinkModel.countDocuments({ clientCode: link.clientCode });

      await UserModel.updateOne({ _id: link.clientCode }, { $set: { no_of_linked_contacts: countLinkedContacts } });
      await ContactsModel.updateOne({ _id: link.email }, { $set: { no_of_linked_clients: countLinkedClients } });
    }

    // Now, update counts for clients and contacts without links
    const allClients = await UserModel.find();
    const allContacts = await ContactsModel.find();

    for (const client of allClients) {
      const countLinkedContacts = await LinkModel.countDocuments({ clientCode: client._id });
      await UserModel.updateOne({ _id: client._id }, { $set: { no_of_linked_contacts: countLinkedContacts } });
    }

    for (const contact of allContacts) {
      const countLinkedClients = await LinkModel.countDocuments({ email: contact._id });
      await ContactsModel.updateOne({ _id: contact._id }, { $set: { no_of_linked_clients: countLinkedClients } });
    }

    res.status(200).json({ message: 'Link counts updated successfully' });
  } catch (error) {
    console.error('Error updating link counts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.delete('/delete-link', async (req, res) => {
  try {
    const { clientCode, email } = req.body;

    // Validate input
    if (!clientCode || !email) {
      return res.status(400).json({ error: 'Client code and email are required' });
    }

    // Find the corresponding user and contact based on clientCode and email
    const client = await UserModel.findOne({ clientCode });
    const contact = await ContactsModel.findOne({ email });

    if (!client || !contact) {
      return res.status(404).json({ error: 'Client or contact not found' });
    }

    // Delete the link
    const result = await LinkModel.deleteOne({ clientCode: client._id, email: contact._id });

    if (result.deletedCount === 1) {
      // Update other counts or perform additional actions as needed
      res.status(200).json({ message: 'Link deleted successfully' });
      await fetch('http://localhost:3000/update-link-counts');
    } else {
      res.status(404).json({ error: 'Link not found' });
    }
  } catch (error) {
    console.error('Error deleting link:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



app.get('/get-linked-contacts/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;

    let links;
    
    if (mongoose.Types.ObjectId.isValid(identifier)) {
      // If it's a valid ObjectId, assume it's a direct reference
      links = await LinkModel.find({ clientCode: identifier }).populate({
        path: 'email',
        model: ContactsModel,
      });
    } else {
      // If not a valid ObjectId, assume it's a clientCode
      const client = await UserModel.findOne({ clientCode: identifier });
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }

      links = await LinkModel.find({ clientCode: client._id }).populate({
        path: 'email',
        model: ContactsModel,
      });
    }

    // Extract details for all linked contacts
    const linkedContacts = links.map(link => {
      const { name, surname, email } = link.email;
      return { name, surname, email };
    });

    res.status(200).json({ linkedContacts });
  } catch (error) {
    console.error('Error fetching linked contacts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/get-links', async (req, res) => {
  try {
    const links = await LinkModel.find().populate('clientCode email');

    // Create a Set of unique link combinations based on clientCode and email
    const uniqueLinks = new Set(links.map(link => JSON.stringify({ clientCode: link.clientCode, email: link.email })));

    // Convert the Set back to an array of unique link objects
    const uniqueLinksArray = Array.from(uniqueLinks).map(link => JSON.parse(link));

    res.status(200).json(uniqueLinksArray);
  } catch (error) {
    console.error('Error fetching links:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get clients route

app.get('/clients', (req, res) => {
  UserModel.find({})
    .then(clients => {
      res.json(clients);
    })
    .catch(err => {

    console.error('Error getting clients:', err);
  })
});

app.get('/contacts', (req, res) => {
  ContactsModel.find({})
    .then(contacts => {
      res.json(contacts);
    })
    .catch(err => {

    console.error('Error getting contacts:', err);
  })
});


// POST endpoint to save client data
app.post('/save-client', async (req, res) => {
  const clientData = req.body;
  try {
    const savedClient = await UserModel.create(clientData);
    console.log('Saved client data:', savedClient);
    res.json(savedClient);
  } catch (error) {
    console.error('Error saving client data:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/save-contact', async (req, res) => {
  const contactData = req.body;
  try {
    const saveContact = await ContactsModel.create(contactData);
    console.log('Contacts data:', saveContact);
    res.json(saveContact);
  } catch (error) {
    console.error('Error saving contact data:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



app.get('/get-contact-email/:email', async (req, res) => {
  const requestedEmail = req.params.email;
  try {
    // Find the contact with the requested email in MongoDB
    const contact = await ContactsModel.findOne({ email: requestedEmail });
    console.log('Contact found:', contact);

    if (contact) {
      res.json({ email: contact.email });
    } else {
      res.status(404).json({ error: 'Email not found' });
    }
  } catch (error) {
    console.error('Error finding contact in MongoDB:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/get-existing-client-codes', async (req, res) => {
  try {
    const existingClientCodes = await UserModel.distinct('clientCode');
    res.json(existingClientCodes);
  } catch (error) {
    console.error('Error fetching existing client codes:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});











app.get('/get-all-client-codes', (req, res) => {
  // Read existing data from the clients.json file
  let fileData = [];
  try {
    const rawData = fs.readFileSync('clients.json');
    fileData = JSON.parse(rawData);
  } catch (err) {
    console.error('Error reading clients.json file:', err);
    res.status(500).json({ error: 'Internal Server Error' });
    return;
  }

  // Extract and send only client codes to the client
  const existingClientCodes = fileData.map(client => client.clientCode);
  res.json(existingClientCodes);
});


app.get('/check-client-code/:clientCode', (req, res) => {
  const requestedClientCode = req.params.clientCode;

  // Read existing data from the clients.json file
  let fileData = [];
  try {
    const rawData = fs.readFileSync('clients.json');
    fileData = JSON.parse(rawData);
  } catch (err) {
    console.error('Error reading clients.json file:', err);
    res.status(500).json({ error: 'Internal Server Error' });
    return;
  }

  console.log('File data:', fileData);

  // Check if the requested client code exists
  const codeExists = fileData.some(client => {
    console.log('Comparing with client code:', client.clientCode);
    return client.clientCode === requestedClientCode;
  });

  console.log('Code exists:', codeExists);

  if (codeExists) {
    res.json({ exists: true, clientCode: requestedClientCode });
  } else {
    res.json({ exists: false, clientCode: requestedClientCode });
  }
});

function isClientCodeUnique(clientCode) {
  // Read existing data from clients.json file
  let fileData = [];
  try {
    const rawData = fs.readFileSync('clients.json');
    fileData = JSON.parse(rawData);
  } catch (err) {
    console.error('Error reading clients.json file:', err);
    return false;
  }

  // Check if the client code already exists in the file
  return !fileData.some(client => client.code === clientCode);
}

app.post('/save-contact', (req, res) => {
  const contactData = req.body;
  console.log('Received contact data:', contactData);
  const contactId = generateContactId();
  contactData.contactId = contactId;
  saveToJson2(contactData);

  if (!isClientCodeUnique(clientData.code)) {
    return res.status(400).json({ "error": "Client code must be unique." });
  }
 
  
  res.json({ "response": "success" });
});

function generateContactId() {
  let fileData = [];

  try {
    // Read contacts.json file synchronously
    const rawData = fs.readFileSync('contacts.json', 'utf8');
    fileData = JSON.parse(rawData);
  } catch (err) {
    console.error('Error reading contacts.json file:', err);
    return 1; // Start with ID 1 if the file is not found or an error occurs
  }

  // Find the maximum contactId
  const maxContactId = fileData.reduce((max, contact) => (contact.contactId > max ? contact.contactId : max), 0);

  // Increment the maximum contactId
  return maxContactId + 1;
}


app.get('/contacts', (req, res) => {
  let fileData = [];

  try {
    // Read contacts.json file synchronously
    const data = fs.readFileSync('contacts.json', 'utf8');
    fileData = JSON.parse(data);
  } catch (err) {
    console.error('Error reading contacts.json file:', err);
    res.status(500).json({ error: 'Internal Server Error' });
    return;
  }

  res.json(fileData);
});
  


function saveToJson(clientData) {

    // Read existing data from file
    let fileData = [];
    try {
      const rawData = fs.readFileSync('clients.json');
      fileData = JSON.parse(rawData); 
    } catch(err) {}
  
    // Append new data
    fileData.push(clientData);
  
    // Write updated array back to file
    fs.writeFileSync('clients.json', JSON.stringify(fileData,null,2));
  
  }

  function saveToJson2(contactData) {

    // Read existing data from file
    let fileData = [];
    try {
      const rawData = fs.readFileSync('contacts.json');
      fileData = JSON.parse(rawData); 
    } catch(err) {}
  
    // Append new data
    fileData.push(contactData);
  
    // Write updated array back to file
    fs.writeFileSync('contacts.json', JSON.stringify(fileData,null,2));
  
  }
  
  
app.listen(3000, () => {
  console.log('Server is running on port 3000');
});


